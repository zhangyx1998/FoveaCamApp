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
#include <functional>
#include <iostream>
#include <mutex>
#include <thread>

#include <pointer.h>
#include <type_name.h>
#include <utils/debug.h>
#include <utils/thread.h>
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
  // Latching false->true only, so it needs no mutex protection of its own (but
  // see #lost-wakeup: shutdown() still flips it under `mutex`).
  std::atomic<bool> flag_terminate{false};
  std::mutex mutex;
  std::condition_variable unfreeze;
  Set<Subscriber<T> *> subscribers;
  std::thread thread;
  // Teardown gate: close()s holding a provably-live stream pointer, in flight
  // toward unsubscribe(). shutdown() drains this to 0 before ~Stream frees
  // `mutex`. spec: docs/spec/core-streams.md#lifetime-order
  std::atomic<int> closes_in_flight_{0};

protected:
  Stream() = default;
  ~Stream() { assert_shutdown_called(); };

  // Derived destructors MUST call shutdown() before their members die — the
  // producer thread may still call into derived virtuals.
  // spec: docs/spec/core-streams.md#assert-shutdown
  void assert_shutdown_called() {
    if (thread.joinable()) {
      ERROR("%s [%p] destroyed without calling shutdown(). Aborting...",
            NAME.c_str(), this);
      std::terminate();
    }
  }

  /** Stop the producer thread and sever subscribers; call from derived dtors. */
  void shutdown() {
    VERBOSE("Shutting down Stream<%s> [%p]", type_name<T>().c_str(), this);
    // Flip flag_terminate UNDER `mutex` (never lock-free) so notify_all cannot
    // race the parking thread's predicate check.
    // spec: docs/spec/core-streams.md#lost-wakeup
    {
      std::scoped_lock lock(mutex);
      flag_terminate = true;
    }
    unfreeze.notify_all();
    if (thread.joinable())
      thread.join();
    eject_all_and_drain();
  }

  // Sever every remaining subscriber, then wait out any in-flight close().
  // Idempotent, teardown-only. Lock order matches the publisher fan-out (stream
  // `mutex`, then each subscriber's state guard via detach()).
  // spec: docs/spec/core-streams.md#eject-and-drain
  void eject_all_and_drain() {
    {
      std::scoped_lock lock(mutex);
      for (Subscriber<T> *sub : subscribers)
        sub->detach();
      subscribers.clear();
    }
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
    set_thread_name(("Stream<" + type_name<T>() + "> @ " +
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
    // Back-pointer to our stream; nulled on close/detach to notify removal.
    Stream<T> *stream;
    // Set by Stream::crash(); immutable once set, so it reads without the guard.
    TracedError::Ptr error = nullptr;
    inline bool isActive() const { return stream != nullptr && !error; }
  };
  Threading::Guard<State> state;

private:
  // Stream-side sever, called ONLY by Stream::eject_all_and_drain() (holding the
  // stream `mutex` + this state guard). Nulls the back-pointer WITHOUT any
  // derived close() hook — teardown-safe (no JS/N-API from env-cleanup). A later
  // own close() then sees stream==nullptr and returns early.
  // spec: docs/spec/core-streams.md#eject-and-drain
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
  /** Freeze the subscriber (null the stream, set the error), then unsubscribe.
   *  Overrides MUST call this base FIRST — it guarantees the state is frozen
   *  before any additional close code. `unsubscribe=false` is Stream-internal
   *  (caller already holds the stream mutex / is erasing us).
   *
   *  Two rules are load-bearing and MUST NOT be undone:
   *  - LOCK ORDER: freeze under the state guard, RELEASE it, THEN unsubscribe —
   *    never hold the state guard across Stream::unsubscribe (opposite of the
   *    fan-out order → deadlock).
   *  - LIFETIME ORDER: bump closes_in_flight_ WHILE holding the state guard,
   *    where `stream` is provably alive, so the drain keeps the mutex alive
   *    across unsubscribe (destroyed-mutex EINVAL abort otherwise).
   *  spec: docs/spec/core-streams.md#lock-order , #lifetime-order */
  virtual void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) {
    Stream<T> *stream;
    {
      auto ref = state.ref();
      if (!ref->stream) // Already closed, do nothing
        return;
      stream = ref->stream;
      ref->stream = nullptr;
      ref->error = err;
      if (unsubscribe)
        stream->closes_in_flight_.fetch_add(1, std::memory_order_acq_rel);
    } // release the state guard BEFORE reaching for the stream mutex (lock-order)
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
