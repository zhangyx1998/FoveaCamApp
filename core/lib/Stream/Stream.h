// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "Threading/Guard.h"
#include "utils/error.h"
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

protected:
  Stream() : thread(&Stream::thread_main, this) {}
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
    flag_terminate = true;
    unfreeze.notify_all();
    if (thread.joinable())
      thread.join();
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

protected:
  /*
   * API exposed to stream object, called from stream thread.
   * When push() is called, the subscriber is **guaranteed to be active**.
   * i.e. close() will always remove the subscriber from the stream before
   * setting the state to inactive.
   */
  virtual void push(const T &item) = 0;

public:
  // NOTE: All calls from Stream must specify `unsubscribe = false` to avoid
  //       calling back to Stream::unsubscribe, which will cause deadlock.
  // Overrides of the function must first call the base class close().
  // This ensures the state is frozen before executing additional close code.
  virtual void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) {
    auto ref = state.ref();
    if (!ref->stream) // Already closed, do nothing
      return;
    if (ref->stream && unsubscribe)
      ref->stream->unsubscribe(this);
    ref->stream = nullptr;
    ref->error = err;
  }

public:
  // Throw Unsubscribe from push() to unsubscribe self from stream.
  class Unsubscribe {};
  Subscriber(Stream<T> *stream)
      : state(stream ? stream->subscribe(this) : nullptr) {}
  ~Subscriber() { close(); }
};
