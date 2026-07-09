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
// namespace Napi`. Defined in core/lib/Aravis/ConverterStream.cpp (the
// per-camera converter thread that replaced the inline-convert CaptureSink).
namespace Arv {
Napi::Value feedTestFrame(const Napi::CallbackInfo &info);
Napi::Value attachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value detachCameraPipe(const Napi::CallbackInfo &info);
Napi::Value enableFakeCamera(const Napi::CallbackInfo &info);
Napi::Value converterProbeAll(const Napi::CallbackInfo &info);
// B-23 (real-1g) + unified-time-and-topology §5 (undistort brick v2), defined
// in core/lib/Aravis/UndistortStream.cpp.
Napi::Value attachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value detachUndistortPipe(const Napi::CallbackInfo &info);
Napi::Value undistortProbeAll(const Napi::CallbackInfo &info);
Napi::Value pushHomography(const Napi::CallbackInfo &info);
Napi::Value setClockOffset(const Napi::CallbackInfo &info);
Napi::Value undistortStall(const Napi::CallbackInfo &info);
Napi::Value __paramRingSelfTest(const Napi::CallbackInfo &info);
// unified-time (2026-07-08): native camera clock calibration read surface +
// THE host time authority. Defined in core/lib/Aravis/ClockCalibration.cpp.
Napi::Value steadyNowNsJs(const Napi::CallbackInfo &info);
Napi::Value clockStabilityAll(const Napi::CallbackInfo &info);
Napi::Value onClockMetrics(const Napi::CallbackInfo &info);
Napi::Value __clockCalSelfTest(const Napi::CallbackInfo &info);
Napi::Value __fireClockMetricsTest(const Napi::CallbackInfo &info);
// B-24 (real-2), defined in core/lib/Aravis/FoveaStream.cpp.
Napi::Value attachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value setFoveaRect(const Napi::CallbackInfo &info);
Napi::Value detachFoveaPipe(const Napi::CallbackInfo &info);
Napi::Value foveaProbeAll(const Napi::CallbackInfo &info);
// split-disparity-nodes: the RESIZE brick, defined in
// core/lib/Aravis/ScaleStream.cpp.
Napi::Value attachScalePipe(const Napi::CallbackInfo &info);
Napi::Value setScaleParams(const Napi::CallbackInfo &info);
Napi::Value detachScalePipe(const Napi::CallbackInfo &info);
Napi::Value scaleProbeAll(const Napi::CallbackInfo &info);
// stereo-disparity-and-heatmap-nodes: the two-input SGBM disparity brick,
// defined in core/lib/Aravis/StereoStream.cpp.
Napi::Value attachStereoPipe(const Napi::CallbackInfo &info);
Napi::Value setStereoParams(const Napi::CallbackInfo &info);
Napi::Value detachStereoPipe(const Napi::CallbackInfo &info);
Napi::Value stereoProbeAll(const Napi::CallbackInfo &info);
// stereo-disparity-and-heatmap-nodes: the colormap brick, defined in
// core/lib/Aravis/HeatmapStream.cpp.
Napi::Value attachHeatmapPipe(const Napi::CallbackInfo &info);
Napi::Value setHeatmapParams(const Napi::CallbackInfo &info);
Napi::Value detachHeatmapPipe(const Napi::CallbackInfo &info);
Napi::Value heatmapProbeAll(const Napi::CallbackInfo &info);
// composite-node-and-center-select-fix: the two-input composite brick
// (anaglyph / L-vs-R difference), defined in core/lib/Aravis/CompositeStream.cpp.
Napi::Value attachCompositePipe(const Napi::CallbackInfo &info);
Napi::Value setCompositeParams(const Napi::CallbackInfo &info);
Napi::Value detachCompositePipe(const Napi::CallbackInfo &info);
Napi::Value compositeProbeAll(const Napi::CallbackInfo &info);
}
// unified-time-and-topology §6: consolidated NodeReport rows for every live
// native brick + pipe. Defined in core/src/Topology.cpp.
namespace Topology {
Napi::Value report(const Napi::CallbackInfo &info);
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
    // unified-time-and-topology §5: the homography-variant control surface —
    // mirror/H history writes (≤ ~1 kHz) + the device→host clock offset.
    Aravis.Set("pushHomography",
               Function::New<Arv::pushHomography>(env, "pushHomography"));
    Aravis.Set("setClockOffset",
               Function::New<Arv::setClockOffset>(env, "setClockOffset"));
    // Test-only: inject per-frame stall into an undistort brick so the
    // converter outruns it — drives the FIFO backpressure + high-water path
    // (core/test/22). Not part of the public d.ts surface.
    Aravis.Set("undistortStall",
               Function::New<Arv::undistortStall>(env, "undistortStall"));
    // Hardware-free native self-test of the ParamRing lookup semantics
    // (core/test/22). Not part of the public d.ts surface.
    Aravis.Set("__paramRingSelfTest", Function::New<Arv::__paramRingSelfTest>(
                                          env, "__paramRingSelfTest"));
    // unified-time: bulk camera clock-stability rows for the 1 Hz clocks
    // poll ({ [serial]: {offsetNs, jitterNs, samples, atNs, ageNs,
    // driftPpm|null} }) + the hardware-free min-filter self-test (test 24).
    Aravis.Set("clockStabilityAll", Function::New<Arv::clockStabilityAll>(
                                        env, "clockStabilityAll"));
    // The clock-metrics PUSH channel (CallbackSlot): arm with a callback,
    // disarm with null. Zero cross-thread cost while disarmed.
    Aravis.Set("onClockMetrics",
               Function::New<Arv::onClockMetrics>(env, "onClockMetrics"));
    Aravis.Set("__clockCalSelfTest", Function::New<Arv::__clockCalSelfTest>(
                                         env, "__clockCalSelfTest"));
    Aravis.Set("__fireClockMetricsTest",
               Function::New<Arv::__fireClockMetricsTest>(
                   env, "__fireClockMetricsTest"));
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
    // split-disparity-nodes: spawn/cancel-able RESIZE pipes — a native
    // cv::resize thread chained on any convert/undistort/fovea/scale pipe,
    // reactive {ratio|dwidth|dheight|dsize} params, C-20 max-footprint dynamic
    // geometry with the source crop origin forwarded unscaled.
    Aravis.Set("attachScalePipe",
               Function::New<Arv::attachScalePipe>(env, "attachScalePipe"));
    Aravis.Set("setScaleParams",
               Function::New<Arv::setScaleParams>(env, "setScaleParams"));
    Aravis.Set("detachScalePipe",
               Function::New<Arv::detachScalePipe>(env, "detachScalePipe"));
    Aravis.Set("scaleProbeAll",
               Function::New<Arv::scaleProbeAll>(env, "scaleProbeAll"));
    // stereo-disparity-and-heatmap-nodes: the FIRST two-input brick — a native
    // cv::StereoSGBM thread pairing two convert/undistort/fovea/scale taps into
    // a CV_32F disparity pipe (reactive {numDisparities|blockSize|minDisparity})
    // + a colormap brick turning a 1-channel (F32/U8) input into a BGRA8 TURBO
    // heatmap. Both on-demand (park with no consumer).
    Aravis.Set("attachStereoPipe",
               Function::New<Arv::attachStereoPipe>(env, "attachStereoPipe"));
    Aravis.Set("setStereoParams",
               Function::New<Arv::setStereoParams>(env, "setStereoParams"));
    Aravis.Set("detachStereoPipe",
               Function::New<Arv::detachStereoPipe>(env, "detachStereoPipe"));
    Aravis.Set("stereoProbeAll",
               Function::New<Arv::stereoProbeAll>(env, "stereoProbeAll"));
    Aravis.Set("attachHeatmapPipe",
               Function::New<Arv::attachHeatmapPipe>(env, "attachHeatmapPipe"));
    Aravis.Set("setHeatmapParams",
               Function::New<Arv::setHeatmapParams>(env, "setHeatmapParams"));
    Aravis.Set("detachHeatmapPipe",
               Function::New<Arv::detachHeatmapPipe>(env, "detachHeatmapPipe"));
    Aravis.Set("heatmapProbeAll",
               Function::New<Arv::heatmapProbeAll>(env, "heatmapProbeAll"));
    // composite-node-and-center-select-fix: the two-input composite brick —
    // a per-pixel BGRA op (anaglyph / L-vs-R difference) pairing two
    // convert/undistort/fovea/scale taps into a BGRA8 pipe (reactive
    // {mode}). On-demand (parks with no consumer).
    Aravis.Set("attachCompositePipe",
               Function::New<Arv::attachCompositePipe>(env, "attachCompositePipe"));
    Aravis.Set("setCompositeParams",
               Function::New<Arv::setCompositeParams>(env, "setCompositeParams"));
    Aravis.Set("detachCompositePipe",
               Function::New<Arv::detachCompositePipe>(env, "detachCompositePipe"));
    Aravis.Set("compositeProbeAll",
               Function::New<Arv::compositeProbeAll>(env, "compositeProbeAll"));
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
    // Consolidated node-topology reporting (unified-time-and-topology §6):
    // one NodeReport[] for every live native brick + advertised pipe.
    auto TopologyNs = Object::New(env);
    TopologyNs.Set("report", Function::New<Topology::report>(env, "report"));
    exports.Set("Topology", TopologyNs);
    // Finalize
    // THE native host time authority (unified-time §1): libc++ steady_clock
    // integer ns. Every clock-calibration offset is in THIS domain; JS
    // hostNowNs delegates here (hrtime is not guaranteed the same Darwin
    // clock domain — one authority only).
    exports.Set("steadyNowNs",
                Function::New<Arv::steadyNowNsJs>(env, "steadyNowNs"));
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
