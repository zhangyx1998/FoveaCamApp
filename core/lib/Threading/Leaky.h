// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "exception.h"
#include <pointer.h>

#include <condition_variable>
#include <mutex>

namespace Threading {

template <typename T> class Leaky : public Shared<Leaky<T>> {
private:
  std::mutex mutex;
  std::condition_variable cond;
  std::shared_ptr<T> ptr = nullptr;
  bool open = true;
  // Lock-free mirror of `ptr != nullptr`. With single-consumer `take`
  // semantics, non-null IS the new-data predicate (the producer only ever
  // stores non-null; only the consumer clears), so emptiness probes need no
  // lock — the mutex remains only for the move itself and the condvar wait.
  std::atomic<bool> full_{false};

  void assign(std::shared_ptr<T> &&ptr) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    this->ptr = ptr;
    full_.store(true, std::memory_order_release);
    cond.notify_all();
  }

  void assign(std::shared_ptr<T> &ptr) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    this->ptr = ptr;
    full_.store(true, std::memory_order_release);
    cond.notify_all();
  }

public:
  ~Leaky() { close(); }

  std::shared_ptr<T> read() {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    return ptr;
  }

  bool next(std::shared_ptr<T> &dst, bool wait = false) {
    std::unique_lock<std::mutex> lock(mutex);
    while (wait && open && (ptr == dst || ptr == nullptr))
      cond.wait(lock);
    if (!open)
      throw EOS();
    if (dst == ptr)
      return false;
    dst = ptr;
    return dst != nullptr;
  }

  std::shared_ptr<T> consume() {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    full_.store(false, std::memory_order_relaxed); // under the lock
    return std::move(ptr);
  }

  // Single-consumer readout: MOVES the value out (slot → null) so a stalled
  // upstream never pins the last payload inside the channel. `next()` keeps
  // the slot as a multi-cursor dedupe anchor, which forces consumers to hold
  // their previous ptr and lock-and-compare it against the slot. With
  // take-semantics, non-null IS "new data": no cursor, and the empty probe is
  // LOCK-FREE (see `full_`); every Leaky in THIS project is a standalone
  // per-consumer channel (LeakyTapChannel, PortPipe latest links) — readers
  // should prefer `take` over `next`.
  bool take(std::shared_ptr<T> &dst, bool wait = false) {
    // Lock-free fast path: a non-waiting poll on an empty slot never touches
    // the mutex (a racing concurrent write is caught on the next poll).
    if (!wait && !full_.load(std::memory_order_acquire))
      return false;
    std::unique_lock<std::mutex> lock(mutex);
    while (wait && open && ptr == nullptr)
      cond.wait(lock);
    if (!open)
      throw EOS();
    if (ptr == nullptr)
      return false;
    dst = std::move(ptr); // moved-from shared_ptr is guaranteed empty
    full_.store(false, std::memory_order_relaxed); // under the lock
    return true;
  }

  /** Whether the slot currently pins a payload — lock-free
   *  (probe/regression surface for the retention fix). */
  bool holds() const { return full_.load(std::memory_order_acquire); }

  void write(std::shared_ptr<T> &data) { assign(data); }
  void write(T &data) { assign(std::make_shared<T>(data)); }
  void write(T &&data) { assign(std::make_shared<T>(std::move(data))); }
  void write(T *data) { assign(std::shared_ptr<T>(data)); }

  void close() {
    std::lock_guard<std::mutex> lock(mutex);
    open = false;
    ptr = nullptr;
    full_.store(false, std::memory_order_relaxed); // under the lock
    cond.notify_all();
  }
};

} // namespace Threading
