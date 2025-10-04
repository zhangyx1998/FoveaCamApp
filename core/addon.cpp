// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <napi.h>

#include "CoreObject.h"
#include "Dispatcher.h"

using namespace Napi;

#define EXTERN(FN, ...)                                                        \
  extern void FN(__VA_ARGS__);                                                 \
  FN

Object init(Env env, Object exports) {
  EXTERN(initGenICamCache)();
  Dispatcher::init(env);
  CORE_OBJECT_EXPORT(CameraObject, env, exports);
  CORE_OBJECT_EXPORT(FrameObject, env, exports);
  CORE_OBJECT_EXPORT(CameraStreamObject, env, exports);
  return exports;
}

Object ModuleInit(Env env, Object exports){JS_EXCEPT_RET(
    { return init(env, exports); }, exports)}

NODE_API_MODULE(FoveaCam, ModuleInit)
