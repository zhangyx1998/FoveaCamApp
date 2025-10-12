// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <napi.h>

#include "CoreObject.h"
#include "Dispatcher.h"

using namespace Napi;

static Object init(Env env, Object exports) {
  JS_EXCEPT(
      {
        VERBOSE("Initializing core module");
        Dispatcher::init(env);
        CORE_OBJECT_EXPORT(CameraObject, env, exports);
        CORE_OBJECT_EXPORT(FrameObject, env, exports);
        CORE_OBJECT_EXPORT(ProtocolObject, env, exports);
        VERBOSE("Core module initialized");
        return exports;
      },
      exports);
}

NODE_API_MODULE(core, init);
