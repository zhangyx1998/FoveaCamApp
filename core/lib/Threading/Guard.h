// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "utils/debug.h"
#include <condition_variable>
#include <mutex>
#include <pointer.h>

#include <type_name.h>

namespace Threading {

/**
 * Example usage:
 *
 * Guard<std::vector<int>> data;
 * {
 *     auto ref = data.ref();
 *     ref->push_back(42);
 * }
 */
template <typename T> class Guard {
private:
  class Context : public Shared<Context> {
  public:
    Context() = default;
    template <typename... Args>
    Context(Args &&...args) : data(std::forward<Args>(args)...) {}
    Context(const Context &) = delete;
    Context &operator=(const Context &) = delete;
    mutable std::mutex mutex;
    mutable T data;
  };
  const Context::Ptr context;

public:
  template <typename... Args>
  Guard(Args &&...args)
      : context(Context::create(std::forward<Args>(args)...)) {}
  Guard(const Guard &) = delete;
  Guard &operator=(const Guard &) = delete;

  class ReferenceAlreadyReleasedError : public std::runtime_error {
  public:
    static inline const std::string NAME = "Guard<" + type_name<T>() + ">";
    ReferenceAlreadyReleasedError()
        : std::runtime_error("Reference to " + NAME + " already released") {}
  };

  class Ref {
  private:
    std::unique_lock<std::mutex> lock;
    Context::Ptr const context;

  public:
    Ref(Context::Ptr ctx) : lock(ctx->mutex), context(ctx) {}
    Ref(const Ref &) = delete;
    Ref &operator=(const Ref &) = delete;
    T *operator->() const {
      if (!lock.owns_lock())
        throw ReferenceAlreadyReleasedError();
      return &context->data;
    }
    T &operator*() const {
      if (!lock.owns_lock())
        throw ReferenceAlreadyReleasedError();
      return context->data;
    }
    void release() {
      if (lock.owns_lock())
        lock.unlock();
    }
    void wait(std::condition_variable &cond) {
      if (!lock.owns_lock())
        throw ReferenceAlreadyReleasedError();
      cond.wait(lock);
    }
  };
  // Accesses the guarded data exclusively (locks the mutex)
  inline Ref ref() { return Ref(context); }
  // Copy constructs a snapshot of the guarded data (locks the mutex)
  inline T snapshot() const {
    std::scoped_lock lock(context->mutex);
    return context->data;
  }
};

} // namespace Threading
