// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstdlib>
#include <napi.h>
#include <thread>
#include <unistd.h>

#include "CoreObject.h"
#include "Dispatcher.h"

using namespace Napi;

bool DEBUGGER_CONNECTED = false;

static FN(cleanup) {
  Cleanup::clear(static_cast<napi_env>(info.Env()));
  return info.Env().Undefined();
}

static Object init(Env env, Object exports) {
  try {
    VERBOSE("Initializing core module (ENV=%p, PID=%d)",
            static_cast<napi_env>(env), getpid());
    Dispatcher::init(env);
    CORE_OBJECT_EXPORT(CameraObject, env, exports);
    CORE_OBJECT_EXPORT(FrameObject, env, exports);
    CORE_OBJECT_EXPORT(ProtocolObject, env, exports);
    CORE_OBJECT_EXPORT(ArUcoDetectorObject, env, exports);
    CORE_OBJECT_EXPORT(RegressionObject, env, exports);
    CORE_OBJECT_EXPORT(VisionNamespace, env, exports);
    CORE_OBJECT_EXPORT(LogNamespace, env, exports);
    exports.Set("cleanup", Function::New(env, cleanup));
    VERBOSE("Core module initialized");
    if (std::getenv("WAIT_DEBUGGER")) {
      INFO("WAIT_DEBUGGER is set. Waiting for debugger to connect (pid=%d)...",
           getpid());
      while (!DEBUGGER_CONNECTED)
        std::this_thread::yield();
    }
    return exports;
  }
  JS_EXCEPT(exports);
}

NODE_API_MODULE(core, init);
