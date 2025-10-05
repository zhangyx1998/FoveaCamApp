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

namespace Threading {

template <typename T> class Leaky : public Shared<Leaky<T>> {
private:
  std::mutex mutex;
  std::condition_variable cond;
  std::shared_ptr<T> ptr = nullptr;
  bool open = true;

  void assign(std::shared_ptr<T> &&ptr) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    this->ptr = ptr;
    cond.notify_all();
  }

  void assign(std::shared_ptr<T> &ptr) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!open)
      throw EOS();
    this->ptr = ptr;
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
    return std::move(ptr);
  }

  void write(std::shared_ptr<T> &data) { assign(data); }
  void write(T &data) { assign(std::make_shared<T>(data)); }
  void write(T &&data) { assign(std::make_shared<T>(std::move(data))); }
  void write(T *data) { assign(std::shared_ptr<T>(data)); }

  void close() {
    std::lock_guard<std::mutex> lock(mutex);
    open = false;
    ptr = nullptr;
    cond.notify_all();
  }
};

} // namespace Threading
