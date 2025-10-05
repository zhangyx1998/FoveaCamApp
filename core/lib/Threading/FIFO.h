// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "exception.h"
#include <utils/pointer.h>

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

  FIFO<T> &flush() {
    std::scoped_lock lock(mutex);
    while (!queue.empty())
      queue.pop();
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
