// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <functional>

#include <napi.h>

#include <pointer.h>

namespace Dispatcher {

using Task = std::function<void(Napi::Env)>;
void init(Napi::Env env);
void dispatch(Napi::Env env, Task &&task);

using Deferred = Napi::Promise::Deferred;

class Future : public Deferred, public Shared<Future> {
public:
  Future(Napi::Env env);
  Future(Deferred &&other);
  ~Future();
  Future(Future &&other) = delete;
  Future(const Future &) = delete;
  Future &operator=(Future &&) = delete;
  using Deferred::Promise;
  using Deferred::Reject;
  using Deferred::Resolve;
};

} // namespace Dispatcher
