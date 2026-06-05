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
    // Aravis Module
    auto Aravis = Object::New(env);
    CORE_OBJECT_EXPORT(CameraObject, env, Aravis);
    CORE_OBJECT_EXPORT(FrameObject, env, Aravis);
    exports.Set("Aravis", Aravis);
    // Controller Module
    auto Controller = Object::New(env);
    CORE_OBJECT_EXPORT(ControllerModule, env, Controller);
    exports.Set("Controller", Controller);
    // Vision Module
    auto Vision = Object::New(env);
    CORE_OBJECT_EXPORT(MarkerDetectorObject, env, Vision);
    CORE_OBJECT_EXPORT(VisionNamespace, env, Vision);
    exports.Set("Vision", Vision);
    // Tracker Module
    auto Tracker = Object::New(env);
    CORE_OBJECT_EXPORT(TrackerNamespace, env, Tracker);
    exports.Set("Tracker", Tracker);
    // Regression Module
    CORE_OBJECT_EXPORT(RegressionObject, env, exports);
    // Geometry Module
    auto Geometry = Object::New(env);
    CORE_OBJECT_EXPORT(GeometryModule, env, Geometry);
    exports.Set("Geometry", Geometry);
    // Compression Module
    auto Compression = Object::New(env);
    CORE_OBJECT_EXPORT(CompressionNamespace, env, Compression);
    exports.Set("Compression", Compression);
    // Log Module
    auto Log = Object::New(env);
    CORE_OBJECT_EXPORT(LogModule, env, Log);
    exports.Set("Log", Log);
    // Finalize
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
