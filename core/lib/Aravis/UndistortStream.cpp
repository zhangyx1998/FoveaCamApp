// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// unified-time-and-topology §5 (B, native re-plumb) NAPI seam: attach/detach
// the UNDISTORT brick v2 + its control surface. The brick consumes the
// CONVERTER's in-process OwnedFrame tap (never the raw Bayer stream):
//   attachUndistortPipe(source, pipeId, options)
//     source  = the convert brick's pipeId (string, preferred — shares the
//               live converter) | a Camera (legacy — a PRIVATE converter
//               `<pipeId>#convert` is created and owned by this binding)
//     options = CameraCalibration (legacy positional) | { cal } → INTRINSIC
//             | { homography: true, ringCapacity? }            → HOMOGRAPHY
// The gated `PipeOfferSubscriber` (pipe's own consumer refcount via
// setConsumerGate) + the ChainedStream tap give the two-transport demand rule:
// this brick runs iff (SHM consumers > 0) OR (a fovea taps it); while running
// its tap keeps the converter awake even at zero convert-pipe consumers.

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "UndistortStream.h"

using namespace Napi;

namespace Arv {

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct UndistortBinding {
  UndistortStream::Ptr stream;                     // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  // Legacy camera-arg attach: the PRIVATE converter this binding created
  // (`<pipeId>#convert`). The stream ALSO holds it (ChainedStream::source_) —
  // this typed handle exists for the topology row. Null for shared sources.
  ConverterStream::Ptr privateSource;
};

static std::mutex g_mutex;
static std::map<std::string, UndistortBinding> g_pipes;

UndistortStream::Ptr findUndistort(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// ---- attach: resolve the source brick, build the variant, gate the offer ---
FN(attachUndistortPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachUndistortPipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();

    // Resolve the tap SOURCE: a live convert brick (by pipeId), or a private
    // converter created here for the legacy Camera argument. The camera
    // SERIAL rides along — the probe's `calibratedClock` reads that camera's
    // explicit clock-calibration state (owner-applied dt, unified-time).
    ChainedStream::Source source;
    std::string sourceId;
    std::string serial;
    ConverterStream::Ptr privateSource;
    if (info[0].IsString()) {
      const auto srcId = info[0].As<Napi::String>().Utf8Value();
      auto conv = findConverter(srcId);
      JS_ASSERT(conv != nullptr, Error,
                "attachUndistortPipe: no converter attached to pipe " + srcId,
                env.Undefined());
      source = conv;
      sourceId = srcId;
      // The converter's camera edge is "camera/<serial>" — strip the prefix.
      const auto &camEdge = conv->sourceId();
      serial = camEdge.rfind("camera/", 0) == 0 ? camEdge.substr(7) : camEdge;
    } else {
      auto camera = convert<Arv::Camera::Ptr>(info[0]);
      // spec.pixelFormat IS the access modifier, exactly like raw pipes.
      const PixelFormat target = convert<PixelFormat>(spec.pixelFormat);
      privateSource = ConverterStream::create(Arv::Stream::get(camera), target,
                                              pipeId + "#convert");
      source = privateSource;
      sourceId = pipeId + "#convert";
      try {
        serial = camera->get_serial();
      } catch (...) {
        serial = "?";
      }
    }

    // Variant selection: {homography} | {cal} | legacy positional calibration.
    UndistortStream::Ptr stream;
    if (info[2].IsObject() &&
        info[2].As<Napi::Object>().Has("homography") &&
        info[2].As<Napi::Object>().Get("homography").ToBoolean().Value()) {
      const auto opts = info[2].As<Napi::Object>();
      size_t ringCapacity = 4096;
      if (opts.Has("ringCapacity") && opts.Get("ringCapacity").IsNumber())
        ringCapacity = opts.Get("ringCapacity").As<Napi::Number>().Uint32Value();
      stream = UndistortStream::create(std::move(source), std::move(sourceId),
                                       ringCapacity, pipeId);
    } else {
      // The PLAIN persisted CameraCalibration JSON — never the env-bound
      // Vision `Undistort` instance (B-23 ruling #1). Maps built in the ctor.
      Napi::Value calValue = info[2];
      if (info[2].IsObject() && info[2].As<Napi::Object>().Has("cal"))
        calValue = info[2].As<Napi::Object>().Get("cal");
      auto cal = convert<CameraCalibration::Ptr>(calValue);
      stream = UndistortStream::create(std::move(source), std::move(sourceId),
                                       cal, pipeId);
    }
    stream->setCameraSerial(std::move(serial));

    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      // On re-attach: drop the gated subscriber FIRST (it points at the old
      // stream), then replace the stream (old one shuts down/joins here).
      b.subscriber.reset();
      b.stream = std::move(stream);
      b.sink = sink;
      b.width = spec.width;
      b.height = spec.height;
      b.privateSource = std::move(privateSource);
    }
    // Register the gate OUTSIDE the lock: it fires immediately with the
    // current consumer state (creating the subscriber if a consumer is
    // already connected), which re-locks g_mutex.
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end())
        return;
      auto &b = it->second;
      if (active && !b.subscriber)
        b.subscriber = std::make_unique<PipeOfferSubscriber>(
            b.stream.get(), b.sink, b.width, b.height);
      else if (!active && b.subscriber)
        b.subscriber.reset();
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding -------------
FN(detachUndistortPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    // Clear the gate before touching the registry so no edge fires into freed
    // state (both are NAPI-thread).
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    UndistortBinding removed; // destructed OUTSIDE the lock (unsubscribe +
                              // stream shutdown/join may block)
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end()) {
        removed = std::move(it->second);
        g_pipes.erase(it);
      }
    }
    return Boolean::New(env, removed.stream != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- homography-variant control surface -------------------------------------
// pushHomography(pipeId, hostNs: bigint, h: Float64Array[9]) — one mirror/H
// sample into the brick's native ParamRing (≤ ~1 kHz JS writer). False for an
// unknown pipe or a non-homography variant.
FN(pushHomography) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    const int64_t hostNs = convert<int64_t>(info[1]);
    const auto h = bufferView<double>(info[2]);
    JS_ASSERT(h.size >= ParamRing::VALUES, TypeError,
              "pushHomography: expected 9 doubles (3x3 row-major)",
              env.Undefined());
    UndistortStream::Ptr stream;
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end())
        stream = it->second.stream;
    }
    if (!stream || stream->variant() != UndistortStream::Variant::Homography)
      return Boolean::New(env, false);
    stream->pushHomography(hostNs, h.data);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// DEPRECATED NO-OP (unified-time ruling 2026-07-08: owner-applied
// timestamps). The camera itself now stamps every frame with its calibrated
// dt at Frame creation (`camera.calibrateClock`), so the per-brick offset
// store is gone — the ParamRing lookup uses `frame.deviceTimestamp` directly.
// Kept as a 0-returning stub only until the one JS caller
// (app/orchestrator/clock-calibration.ts, coordinator-owned) drops it; then
// delete this export + its d.ts row.
FN(setClockOffset) {
  auto env = info.Env();
  return Number::New(env, 0);
}

// ---- per-pipeId undistort meter snapshots (perfSnapshot.workloads sibling) --
// Full WorkloadSnapshot schema + the v2 variant surface: {variant, calibratedClock,
// passthrough} — an UNCALIBRATED homography brick is visible at a glance.
FN(undistortProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto o = meterSnapshotToJs(env, b.stream->probe()).As<Napi::Object>();
    o.Set("variant", Napi::String::New(env, b.stream->variantName()));
    o.Set("calibratedClock", Napi::Boolean::New(env, b.stream->calibratedClock()));
    o.Set("passthrough",
          Napi::Number::New(env,
                            static_cast<double>(b.stream->passthroughCount())));
    out.Set(pipeId, o);
  }
  return out;
}

// ---- Topology.report() rows (unified-time-and-topology §6) ------------------
// TODO(B-r2): chained-brick input/output types are tagged BGRA8/U8 — true for
// every live chain today (the converter target is the pipe's advertised
// format, BGRA8 everywhere). Carry the source brick's actual target format
// through the binding once a non-BGRA chain exists.
void appendUndistortReports(Napi::Env env, Napi::Array &rows,
                            std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    // A legacy private converter is a REAL node — report it (its id is never
    // an advertised pipe, so it stays transport "native").
    if (b.privateSource)
      appendConvertNodeRow(env, rows, b.privateSource->name(),
                           b.privateSource);
    auto row = Topology::node(env, pipeId, "undistort", "native");
    Topology::addInput(env, row, b.stream->sourceId(), "frame",
                       Topology::frameType(env, "BGRA8", "U8"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "BGRA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

// ---- ParamRing native self-test (hardware-free; driven by core/test/22) ----
// Runs the lookup-semantics assertions wholly in C++ (exact hit, midpoint
// interpolation, before-oldest clamp, after-newest clamp, empty-ring miss,
// capacity wrap). Throws with a description on the first failure.
FN(__paramRingSelfTest) {
  auto env = info.Env();
  try {
    auto expect = [](bool cond, const char *what) {
      if (!cond)
        throw std::runtime_error(std::string("ParamRing self-test: ") + what);
    };
    ParamRing ring(4);
    ParamRing::Params out{};
    expect(!ring.lookup(0, out), "empty ring must miss");
    auto entry = [](double v) {
      ParamRing::Params p{};
      for (size_t i = 0; i < ParamRing::VALUES; ++i)
        p[i] = v + static_cast<double>(i);
      return p;
    };
    const auto e10 = entry(10), e20 = entry(20);
    ring.push(1000, e10.data());
    ring.push(2000, e20.data());
    expect(ring.lookup(1000, out) && out == e10, "exact hit at oldest");
    expect(ring.lookup(2000, out) && out == e20, "exact hit at newest");
    expect(ring.lookup(500, out) && out == e10, "before-oldest clamps");
    expect(ring.lookup(9000, out) && out == e20, "after-newest clamps");
    expect(ring.lookup(1500, out), "midpoint hits");
    for (size_t i = 0; i < ParamRing::VALUES; ++i)
      expect(out[i] == (e10[i] + e20[i]) / 2, "midpoint interpolates");
    expect(ring.lookup(1250, out) && out[0] == 12.5, "quarter interpolates");
    // Capacity wrap: 4-slot ring keeps the NEWEST four samples.
    const auto e30 = entry(30), e40 = entry(40), e50 = entry(50);
    ring.push(3000, e30.data());
    ring.push(4000, e40.data());
    ring.push(5000, e50.data());
    expect(ring.size() == 4, "capacity bounds the ring");
    expect(ring.lookup(1000, out) && out == e20,
           "evicted oldest clamps to the surviving oldest");
    expect(ring.lookup(5000, out) && out == e50, "newest after wrap");
    expect(ring.lookup(4500, out) && out[0] == 45.0, "interp after wrap");
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Arv
