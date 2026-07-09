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
#include <queue>

namespace Threading {

template <typename T> class FIFO : public Shared<FIFO<T>> {
private:
  std::queue<T> queue;
  std::mutex mutex;
  std::condition_variable cond_r, cond_w;
  bool closed = false;
  // Maximum size of queue, 0 for unlimited
  size_t max_size = 0;
  // Exact high-water mark: the largest queue.size() ever observed at push
  // (under the same mutex). `take_high_water()` reads-and-resets it so a
  // reader can maintain a windowed max (FIFO-edge metering, controller-node-
  // and-fifo-edges §1). Never decreases except on take/flush.
  size_t high_water_ = 0;

  void push(T data) {
    std::unique_lock lock(mutex);
    while (max_size > 0 && queue.size() >= max_size && !closed)
      cond_r.wait(lock);
    if (closed) {
      lock.unlock();
      cond_w.notify_all();
      throw EOS();
    }
    queue.push(data);
    if (queue.size() > high_water_)
      high_water_ = queue.size();
    cond_w.notify_all();
  }

  void push(T &&data) {
    std::unique_lock lock(mutex);
    while (max_size > 0 && queue.size() >= max_size && !closed)
      cond_r.wait(lock);
    if (closed) {
      lock.unlock();
      cond_w.notify_all();
      throw EOS();
    }
    queue.push(data);
    if (queue.size() > high_water_)
      high_water_ = queue.size();
    cond_w.notify_all();
  }

public:
  FIFO(size_t max_size = 0) : max_size(max_size) {}

  void wait_read() {
    std::unique_lock lock(mutex);
    if (closed)
      throw EOS();
    cond_r.wait(lock);
    if (closed)
      throw EOS();
  }

  size_t queued_size() {
    std::scoped_lock lock(mutex);
    return queue.size();
  }

  // Capacity bound (0 == unbounded). Immutable after construction.
  size_t capacity() const { return max_size; }

  // Peak occupancy ever observed at a push (not yet reset).
  size_t high_water() {
    std::scoped_lock lock(mutex);
    return high_water_;
  }

  // Return the peak occupancy since the previous call and reset the tracker to
  // the CURRENT occupancy (so it never under-reports a still-backed-up queue).
  // A reader calls this once per drain to feed a windowed-max meter.
  size_t take_high_water() {
    std::scoped_lock lock(mutex);
    const size_t hw = high_water_;
    high_water_ = queue.size();
    return hw;
  }

  FIFO<T> &flush() {
    std::scoped_lock lock(mutex);
    while (!queue.empty())
      queue.pop();
    high_water_ = 0;
    return *this;
  }

  void write(T *data) { push(*data); }
  void write(T &data) { push(data); }
  void write(T &&data) { push(data); }

  T read() {
    std::unique_lock lock(mutex);
    while (queue.empty() && !closed)
      cond_w.wait(lock);
    if (queue.empty() && closed) {
      lock.unlock();
      cond_r.notify_all();
      throw EOS();
    }
    T data = queue.front();
    queue.pop();
    lock.unlock();
    cond_r.notify_all();
    return data;
  }

  T read(unsigned timeout_ms) {
    std::unique_lock lock(mutex);
    while (queue.empty() && !closed)
      cond_w.wait_until(lock, std::chrono::steady_clock::now() +
                                  std::chrono::milliseconds(timeout_ms));
    if (queue.empty()) {
      lock.unlock();
      cond_r.notify_all();
      if (closed)
        throw EOS();
      else
        throw Timeout();
    }
    T data = queue.front();
    queue.pop();
    lock.unlock();
    cond_r.notify_all();
    return data;
  }

  void close() {
    std::unique_lock lock(mutex);
    closed = true;
    lock.unlock();
    cond_r.notify_all();
    cond_w.notify_all();
  }
};

} // namespace Threading
