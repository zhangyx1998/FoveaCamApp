// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "Threading/Guard.h"
#include "utils/error.h"
#include <atomic>
#include <condition_variable>
#include <exception>
#include <iostream>
#include <mutex>
#include <thread>

#include <pointer.h>
#include <type_name.h>
#include <utils/debug.h>
#include <utils/map-set.h>
#include <utils/stacktrace.h>

class StreamError : public std::runtime_error {
public:
  const std::string stack;
  StreamError(const std::exception &e)
      : std::runtime_error(e.what()), stack(Stacktrace::capture()) {}
};

class StopIteration : public std::exception {};

template <SmartPtrLike T> class Subscriber;

// Shared<Stream> is intentionally not supported:
// Add it to inherited classes if needed.
template <SmartPtrLike T> class Stream {
public:
  using Payload = T;
  friend class Subscriber<T>;
  static inline const std::string NAME = "Stream<" + type_name<T>() + ">";

private:
  // State transfer: false -> true (not the other way)
  // The flag is not protected by mutex given its state transfer type.
  std::atomic<bool> flag_terminate{false};
  std::mutex mutex;
  std::condition_variable unfreeze;
  Set<Subscriber<T> *> subscribers;
  std::thread thread;
  // Count of Subscriber::close(unsubscribe=true) calls that have captured a
  // LIVE pointer to this stream (under the subscriber's state guard) and are in
  // flight toward unsubscribe(). The increment lands while our pointer is still
  // provably live (see LIFETIME ORDER in Subscriber::close); the decrement
  // follows unsubscribe(). shutdown() drains this to 0 BEFORE `mutex` is
  // destroyed, so no unsubscribe() ever locks/unlocks a freed mutex (the
  // 2026-07-09 destroyed-mutex EINVAL abort). Never contended on the hot path
  // (close/shutdown only).
  std::atomic<int> closes_in_flight_{0};

protected:
  Stream() = default;
  ~Stream() { assert_shutdown_called(); };

  void assert_shutdown_called() {
    // Thread must be joined before derived class destruction
    // Because the thread may call into virtual functions of derived class.
    // This is checked here to avoid potential hard-to-debug issues.
    // Derived classes should call shutdown() in their destructor
    if (thread.joinable()) {
      ERROR("%s [%p] destroyed without calling shutdown(). Aborting...",
            NAME.c_str(), this);
      std::terminate();
    }
  }

  // Call this from derived class destructor to safely stop the thread
  void shutdown() {
    VERBOSE("Shutting down Stream<%s> [%p]", type_name<T>().c_str(), this);
    // LOST-WAKEUP FIX: set the terminate flag UNDER `mutex`. wait_activate()
    // evaluates its predicate (which reads flag_terminate) while holding `mutex`
    // and then atomically unlocks+sleeps in unfreeze.wait(). If we flipped the
    // flag + notified WITHOUT the mutex (the historical code), the notify could
    // land in the gap after the parking thread read the flag as false but before
    // it blocked — a lost wakeup: the producer sleeps forever and the join below
    // hangs, so the orchestrator never exits and hardware stays armed (a hung
    // teardown violates the quiescence invariant as badly as an aborted one).
    // Flipping it under `mutex` serializes against that predicate check, so the
    // subsequent notify_all is never lost.
    {
      std::scoped_lock lock(mutex);
      flag_terminate = true;
    }
    unfreeze.notify_all();
    if (thread.joinable())
      thread.join();
    // TEARDOWN EJECT + DRAIN (destroyed-mutex race fix; see LIFETIME ORDER in
    // Subscriber::close). The join above guarantees THIS stream's own thread can
    // never touch `mutex`/`subscribers` again. What remains is a cross-thread
    // Subscriber::close() racing our destruction: on a CLEAN shutdown (unlike
    // crash()) the base historically left every subscriber's back-pointer intact
    // — so a subscriber destroyed AFTER us would close()->unsubscribe() and lock
    // a freed `mutex`. Fix in two moves, both before ~Stream frees `mutex`:
    //   (1) eject: null every still-attached subscriber's back-pointer so any
    //       LATER close() sees a dead stream and skips unsubscribe();
    //   (2) drain: wait out any close() already past its null-check and in flight
    //       toward unsubscribe() (counted in closes_in_flight_).
    eject_all_and_drain();
  }

  // Sever every remaining subscriber and wait for in-flight closes. Idempotent
  // (a re-entry finds an empty set and a zero counter). Runs on the teardown
  // path only; not a hot path.
  //
  // Lock order matches the publisher fan-out (stream `mutex` FIRST, then each
  // subscriber's state guard via detach()) — never the reverse — so it cannot
  // deadlock against Subscriber::close (which takes ONLY the state guard, then
  // an atomic, then releases before reaching for `mutex`).
  void eject_all_and_drain() {
    {
      std::scoped_lock lock(mutex);
      for (Subscriber<T> *sub : subscribers)
        sub->detach();
      subscribers.clear();
    }
    // Any close() that captured our pointer BEFORE the eject above (already
    // incremented closes_in_flight_ under its state guard) is now headed into
    // unsubscribe(); spin until it has finished touching `mutex`. New closes
    // arriving AFTER the eject see a nulled back-pointer and never increment.
    while (closes_in_flight_.load(std::memory_order_acquire) != 0)
      std::this_thread::yield();
  }

  Stream *subscribe(Subscriber<T> *subscriber) {
    if (!subscriber)
      return nullptr;
    if (flag_terminate) {
      WARN("[%s] Subscribing an already terminated stream.", NAME.c_str());
      subscriber->close(false);
      return nullptr;
    }
    std::scoped_lock lock(mutex);
    subscribers.insert(subscriber);
    if (!thread.joinable())
      thread = std::thread(&Stream::thread_main, this);
    unfreeze.notify_all();
    return this;
  };

  void unsubscribe(Subscriber<T> *subscriber) {
    std::scoped_lock lock(mutex);
    subscribers.erase(subscriber);
  };

  // Called by Stream thread
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual T iterate() = 0;

  void loop() noexcept {
    try {
      start();
    } catch (const std::exception &e) {
      flag_terminate = true;
      std::scoped_lock lock(mutex);
      crash(NAME + "::start crashed: " + e.what());
      return;
    } catch (...) {
      flag_terminate = true;
      std::scoped_lock lock(mutex);
      crash("Unknown exception at " + NAME + "::start");
      return;
    }
    try {
      while (!flag_terminate) {
        auto item = iterate();
        if (item == nullptr) {
          std::scoped_lock lock(mutex);
          if (subscribers.empty())
            break;
          std::this_thread::yield();
          continue;
        }
        std::scoped_lock lock(mutex);
        if (subscribers.empty())
          break;
        std::vector<Subscriber<T> *> to_remove;
        for (auto sub : subscribers) {
          try {
            auto ref = sub->state.ref();
            if (ref->isActive())
              sub->push(item);
          } catch (Subscriber<T>::Unsubscribe) {
            sub->close(false);
            to_remove.push_back(sub);
          } catch (const std::exception &e) {
            sub->close(false, TracedError::create(e));
            to_remove.push_back(sub);
          } catch (...) {
            sub->close(false, TracedError::create(
                                  "Unknown exception when pushing item"));
            to_remove.push_back(sub);
          }
        }
        for (auto sub : to_remove) {
          subscribers.erase(sub);
        }
      }
    } catch (StopIteration &) {
      // Normal termination
    } catch (std::exception &e) {
      crash(NAME + "::loop crashed: " + e.what());
    } catch (...) {
      crash("Unknown exception at " + NAME + "::loop");
    }
    try {
      stop();
    } catch (std::exception &e) {
      crash(NAME + "::stop crashed: " + e.what());
      return;
    } catch (...) {
      crash("Unknown exception at " + NAME + "::stop");
      return;
    }
  }

  void crash(std::string error_message) {
    flag_terminate = true;
    auto error = TracedError::create(error_message);
    std::scoped_lock lock(mutex);
    __clear_subscribers__(error);
  }

  inline bool __activate__() { return !subscribers.empty() || flag_terminate; }

  inline void wait_activate() {
    std::unique_lock lock(mutex);
    if (__activate__())
      return;
    unfreeze.wait(lock, [this] { return __activate__(); });
  }
  void thread_main() {
    pthread_setname_np(("Stream<" + type_name<T>() + "> @ " +
                        std::to_string(reinterpret_cast<uintptr_t>(this)))
                           .c_str());
    while (true) {
      VERBOSE("Stream<%s> [%p] waiting", type_name<T>().c_str(), this);
      wait_activate();
      if (flag_terminate)
        break;
      VERBOSE("Stream<%s> [%p] starting", type_name<T>().c_str(), this);
      loop();
      VERBOSE("Stream<%s> [%p] paused", type_name<T>().c_str(), this);
      if (flag_terminate)
        break;
    }
    VERBOSE("Stream<%s> [%p] terminated", type_name<T>().c_str(), this);
  }

  typedef void (*OnClose)(void *hint);
  std::function<void()> on_close;

  void __clear_subscribers__(TracedError::Ptr error = nullptr) {
    for (Subscriber<T> *sub : subscribers)
      sub->close(false, error);
    subscribers.clear();
  }
};

// Subscriber can be ejected from both end:
// 1. When stream crashes/terminates, stream pops all subscribers
// 2. When subscriber is destructed from the subscribing end, it notifies the
//    stream to pop only this subscriber.
template <SmartPtrLike T> class Subscriber {
  friend class Stream<T>;

public:
  class State {
  public:
    State() = delete;
    inline State(Stream<T> *stream) : stream(stream) {}
    // Pointer back to the stream we are subscribed to.
    // This is used to notify the stream to remove us when destructed.
    Stream<T> *stream;
    // Error state set by Stream::crash().
    // Once set, the error message is immutable and can be read without lock.
    // i.e. It's safe to check and read error without acquiring state_mutex.
    TracedError::Ptr error = nullptr;
    // Utility function to check if the subscriber is still active.
    inline bool isActive() const { return stream != nullptr && !error; }
  };
  Threading::Guard<State> state;

private:
  // Stream-side sever, called ONLY by Stream::eject_all_and_drain() during the
  // stream's own teardown, holding the stream `mutex` and (here) this state
  // guard. Nulls the back-pointer WITHOUT running any derived close() hook (no
  // future drain / dispatch — teardown-safe, avoiding a call into JS/N-API from
  // an env-cleanup context). After this our own close() sees stream==nullptr
  // and returns early.
  void detach() {
    auto ref = state.ref();
    ref->stream = nullptr;
  }

protected:
  /*
   * API exposed to stream object, called from stream thread.
   * When push() is called, the subscriber is **guaranteed to be active**.
   * i.e. close() will always remove the subscriber from the stream before
   * setting the state to inactive.
   */
  virtual void push(const T &item) = 0;

public:
  // Overrides of the function must first call the base class close().
  // This ensures the state is frozen before executing additional close code.
  //
  // LOCK ORDER: the state guard must NOT be held across the call into
  // Stream::unsubscribe (which takes the stream's `mutex`). The publisher-side
  // fan-out in Stream::loop() holds the stream `mutex` first, then takes each
  // subscriber's state guard — so holding state here while reaching for the
  // stream mutex is the opposite order and deadlocks (a TransformStream thread
  // exiting → ~Latest → ~Subscriber → close(true) racing its upstream fan-out
  // wedged the whole app: the fan-out stuck wanting a state guard, this
  // unsubscribe stuck wanting the stream mutex). Therefore: freeze the state
  // under the guard (capture + null the stream pointer, set the error), RELEASE
  // the guard, and only then unsubscribe.
  //
  // This reorder is safe:
  //  1. push() is still never called on a closed subscriber: the fan-out checks
  //     ref->isActive() under the state guard, and once we have nulled the
  //     stream (under that same guard) a concurrent fan-out skips this sub.
  //  2. No use-after-free: unsubscribe() blocks on the stream mutex, which the
  //     fan-out holds for its entire iteration; so this subscriber cannot be
  //     erased (and thus ~Subscriber cannot complete) while the loop might
  //     still dereference it. Once unsubscribe returns, we are out of the set
  //     and the loop can never touch us again.
  //  3. Double-close stays idempotent: a second call sees stream==nullptr and
  //     returns early.
  //  4. Derived overrides (Sub::Queue / Sub::Latest / TapPublisher /
  //     RecordSink) call this base FIRST, then drain on a *different* guard —
  //     they only rely on the state being frozen (stream nulled + error set)
  //     before we return, which still holds.
  //
  // LIFETIME ORDER (destroyed-mutex race, the 2026-07-09 exit-6 abort): the
  // reorder above releases the state guard before locking `stream->mutex`, which
  // means nothing here intrinsically keeps `stream` ALIVE across the
  // unsubscribe() call — a concurrent ~Stream (owning brick teardown) could free
  // `stream->mutex` in that gap, and unsubscribe() would then lock a destroyed
  // mutex (macOS libc++ std::mutex reports EINVAL -> std::system_error -> thrown
  // from a noexcept ~Subscriber -> std::terminate). Closed by pairing this with
  // Stream::eject_all_and_drain():
  //  a. Before ~Stream frees `mutex`, shutdown() nulls EVERY subscriber's back-
  //     pointer under that subscriber's OWN state guard. So the only way to
  //     observe `ref->stream != nullptr` while holding the state guard is that
  //     the eject has NOT yet processed us — which (because it needs this same
  //     guard) means it is blocked behind us and cannot have advanced to free
  //     the stream. Therefore `stream` is provably ALIVE at the increment below.
  //  b. We bump closes_in_flight_ WHILE STILL HOLDING the state guard (a plain
  //     atomic — no lock, so the ee6fc46 lock order is untouched). shutdown()'s
  //     drain refuses to return (and thus ~Stream refuses to free `mutex`) until
  //     this count is 0, i.e. until our unsubscribe() below and its matching
  //     decrement have completed. A close() that arrives AFTER the eject sees
  //     stream==nullptr at the guard and never increments.
  //
  // Historical NOTE: calls originating from Stream itself pass
  // `unsubscribe = false` (they already hold the stream mutex / are erasing us
  // directly), so they never reach the unsubscribe path regardless.
  virtual void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) {
    Stream<T> *stream;
    {
      auto ref = state.ref();
      if (!ref->stream) // Already closed, do nothing
        return;
      stream = ref->stream;
      ref->stream = nullptr;
      ref->error = err;
      // Take the teardown gate while `stream` is provably alive (see LIFETIME
      // ORDER above): held under the state guard, so eject_all_and_drain()
      // cannot have freed the stream yet.
      if (unsubscribe)
        stream->closes_in_flight_.fetch_add(1, std::memory_order_acq_rel);
    } // release the state guard BEFORE reaching for the stream mutex
    if (unsubscribe) {
      stream->unsubscribe(this);
      stream->closes_in_flight_.fetch_sub(1, std::memory_order_acq_rel);
    }
  }

public:
  // Throw Unsubscribe from push() to unsubscribe self from stream.
  class Unsubscribe {};
  Subscriber(Stream<T> *stream)
      : state(stream ? stream->subscribe(this) : nullptr) {}
  ~Subscriber() { close(); }
};
