// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <functional>
#include <napi.h>
#include <uv.h>

namespace Dispatcher {

using Task = std::function<void(Napi::Env)>;
void dispatch(Napi::Env env, Task task);
void init(Napi::Env &env);

} // namespace Dispatcher
