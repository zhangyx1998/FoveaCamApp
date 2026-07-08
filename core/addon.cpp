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
#include "Pipe.h"
#include "ShmRing.h"

// Forward-declared (not #included) so the Aravis headers' global `Object`
// template doesn't collide with `Napi::Object` under this file's `using
// namespace Napi`. Defined in core/lib/Aravis/CaptureSink.cpp.
namespace Arv {
Napi::Value feedTestFrame(const Napi::CallbackInfo &info);
Napi::Value attachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value detachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value enableFakeCamera(const Napi::CallbackInfo &info);
Napi::Value converterProbeAll(const Napi::CallbackInfo &info);
// B-23 (real-1g), defined in core/lib/Aravis/UndistortStream.cpp.
Napi::Value attachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value detachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value undistortProbeAll(const Napi::CallbackInfo &info);
// B-24 (real-2), defined in core/lib/Aravis/FoveaStream.cpp.
Napi::Value attachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value setFoveaRect(const Napi::CallbackInfo &info);
Napi::Value detachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value foveaProbeAll(const Napi::CallbackInfo &info);
}

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
    // B-16 no-hardware loopback hook: convert+offer a synthetic frame through
    // the real Pipe ring (see core/test/11-capture-pipe.ts). Test-only.
    Aravis.Set("feedTestFrame",
               Function::New<Arv::feedTestFrame>(env, "feedTestFrame"));
    // B-17 cut-over seam: A's registry attaches/detaches a camera→pipe producer.
    Aravis.Set("attachCameraPipe",
               Function::New<Arv::attachCameraPipe>(env, "attachCameraPipe"));
    Aravis.Set("detachCameraPipe",
               Function::New<Arv::detachCameraPipe>(env, "detachCameraPipe"));
    Aravis.Set("enableFakeCamera",
               Function::New<Arv::enableFakeCamera>(env, "enableFakeCamera"));
    // B-18: per-pipeId converter-thread meter snapshots (A splices into
    // perfSnapshot.workloads alongside Pipe.probeAll()).
    Aravis.Set("converterProbeAll",
               Function::New<Arv::converterProbeAll>(env, "converterProbeAll"));
    // B-23 (real-1g): undistort pipes — a native convert+remap thread per
    // (camera × spec.pixelFormat), maps built at attach from the persisted
    // CameraCalibration JSON; gated by the pipe's own consumer refcount.
    Aravis.Set("attachUndistortPipe",
               Function::New<Arv::attachUndistortPipe>(env, "attachUndistortPipe"));
    Aravis.Set("detachUndistortPipe",
               Function::New<Arv::detachUndistortPipe>(env, "detachUndistortPipe"));
    Aravis.Set("undistortProbeAll",
               Function::New<Arv::undistortProbeAll>(env, "undistortProbeAll"));
    // B-24 (real-2): spawn/cancel-able fovea crop pipes — fused map-ROI
    // convert+remap+crop per (camera × pipe), live-steerable rect, C-20
    // max-footprint dynamic geometry. Probe keys + meter names = pipeId.
    Aravis.Set("attachFoveaPipe",
               Function::New<Arv::attachFoveaPipe>(env, "attachFoveaPipe"));
    Aravis.Set("setFoveaRect",
               Function::New<Arv::setFoveaRect>(env, "setFoveaRect"));
    Aravis.Set("detachFoveaPipe",
               Function::New<Arv::detachFoveaPipe>(env, "detachFoveaPipe"));
    Aravis.Set("foveaProbeAll",
               Function::New<Arv::foveaProbeAll>(env, "foveaProbeAll"));
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
    // Shared-memory frame transport helpers
    auto Shm = Object::New(env);
    ShmRing::exportShmNamespace(env, Shm);
    exports.Set("Shm", Shm);
    // WS1 producer/publisher pipe broker (C-16)
    auto PipeNs = Object::New(env);
    Pipe::exportPipeNamespace(env, PipeNs);
    exports.Set("Pipe", PipeNs);
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
