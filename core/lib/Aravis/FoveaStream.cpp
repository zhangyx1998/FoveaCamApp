// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// unified-time-and-topology §5 (B, native re-plumb) NAPI seam: spawn/cancel-
// able fovea crop pipes, RE-BASED on the undistort brick's OwnedFrame tap
// (chain convert → undistort → fovea; the fused map-ROI path is retired):
//   attachFoveaPipe(source, pipeId, options)
//     source  = an UNDISTORT pipeId (preferred — crop of the undistorted
//               space) | a CONVERT pipeId (raw crop) | a Camera (legacy — a
//               private convert [+ intrinsic undistort when options.cal is
//               given] chain `<pipeId>#convert`/`#undistort` is created and
//               owned by this binding)
//     options = { rect, cal? } — cal only meaningful with a Camera source.
// The gated `PipeOfferSubscriber` stays MAX-BOUND (C-20: per-frame active w/h
// ≤ the advertised max footprint, frame-bound originX/originY in the v4 slot
// header). `setFoveaRect` steers the crop live — no re-attach, no gate churn.
// Probe keys AND meter names = the pipeId (= C-24 node id).

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "FoveaStream.h"
#include "UndistortStream.h"

using namespace Napi;

namespace Arv {

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct FoveaBinding {
  FoveaStream::Ptr stream;                         // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
  // Legacy camera-arg attach: the PRIVATE chain this binding created (also
  // held alive through ChainedStream::source_; typed handles exist for the
  // topology rows). Null for shared string sources.
  ConverterStream::Ptr privateConvert;
  UndistortStream::Ptr privateUndistort;
};

static std::mutex g_mutex;
static std::map<std::string, FoveaBinding> g_pipes;

// Cross-brick lookup (ScaleStream chains on a fovea/slice pipe): the live fovea
// brick bound to `pipeId`, or nullptr (mirrors findUndistort/findConverter).
FoveaStream::Ptr findFovea(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// ---- attach: resolve the source brick (or build a private chain), gate -----
FN(attachFoveaPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachFoveaPipe: options object required", env.Undefined());
    const auto opts = info[2].As<Napi::Object>();
    const auto rect = convert<cv::Rect>(opts.Get("rect"));
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachFoveaPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // C-20 footprint cap: the ring is sized to max (defaults to nominal).
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    const bool hasCal = opts.Has("cal") && !opts.Get("cal").IsUndefined() &&
                        !opts.Get("cal").IsNull();

    ChainedStream::Source source;
    std::string sourceId;
    bool undistorted = false;
    ConverterStream::Ptr privateConvert;
    UndistortStream::Ptr privateUndistort;
    if (info[0].IsString()) {
      const auto srcId = info[0].As<Napi::String>().Utf8Value();
      JS_ASSERT(!hasCal, TypeError,
                "attachFoveaPipe: `cal` is not accepted with a source pipeId "
                "— chain on an undistort pipe instead (fused map-ROI retired)",
                env.Undefined());
      if (auto und = findUndistort(srcId)) {
        source = und;
        undistorted = true;
      } else if (auto conv = findConverter(srcId)) {
        source = conv; // raw crop of the converted stream
      } else {
        JS_THROW(Error,
                 "attachFoveaPipe: no undistort/convert brick on pipe " + srcId,
                 env.Undefined());
      }
      sourceId = srcId;
    } else {
      // Legacy Camera source: build the private chain this fovea needs.
      // TODO(B-r2): retire once the JS registry chains foveas on the shared
      // camera/<serial>/undistort brick (this path full-frame-remaps PER
      // fovea — correct, but N× the shared-brick cost).
      auto camera = convert<Arv::Camera::Ptr>(info[0]);
      const PixelFormat target = convert<PixelFormat>(spec.pixelFormat);
      privateConvert = ConverterStream::create(Arv::Stream::get(camera),
                                               target, pipeId + "#convert");
      source = privateConvert;
      sourceId = pipeId + "#convert";
      if (hasCal) {
        // Plain persisted CameraCalibration JSON (never the env-bound Vision
        // `Undistort` instance — B-23 ruling #1).
        auto cal = convert<CameraCalibration::Ptr>(opts.Get("cal"));
        privateUndistort = UndistortStream::create(
            source, sourceId, cal, pipeId + "#undistort");
        try {
          privateUndistort->setCameraSerial(camera->get_serial());
        } catch (...) {
        }
        source = privateUndistort;
        sourceId = pipeId + "#undistort";
        undistorted = true;
      }
    }

    auto stream = FoveaStream::create(std::move(source), std::move(sourceId),
                                      pipeId, rect, maxW, maxH, undistorted);
    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      b.subscriber.reset(); // re-attach: gated sub points at the old stream
      b.stream = std::move(stream);
      b.sink = sink;
      b.maxW = maxW;
      b.maxH = maxH;
      b.privateConvert = std::move(privateConvert);
      b.privateUndistort = std::move(privateUndistort);
    }
    // Register the gate OUTSIDE the lock (fires immediately with the current
    // consumer state, re-locking g_mutex).
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end())
        return;
      auto &b = it->second;
      if (active && !b.subscriber)
        b.subscriber = std::make_unique<PipeOfferSubscriber>(
            b.stream.get(), b.sink, b.maxW, b.maxH, /*maxBound=*/true);
      else if (!active && b.subscriber)
        b.subscriber.reset();
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- live steering: new crop rect applied on the NEXT frame ----------------
FN(setFoveaRect) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    const auto rect = convert<cv::Rect>(info[1]);
    std::scoped_lock lock(g_mutex);
    auto it = g_pipes.find(pipeId);
    if (it == g_pipes.end() || !it->second.stream)
      return Boolean::New(env, false);
    it->second.stream->setRect(rect);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachFoveaPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    FoveaBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
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

// ---- probes: keyed by pipeId (= node id), meter name == key -----------------
// Extra fields: the active rect of the LAST produced fovea (activeWidth/
// activeHeight for edge byte-rates on variable-size pipes, plus origin). The
// authoritative FRAME-BOUND rect rides each frame's v4 slot header (origin +
// active w/h, via FrameInfo) — this probe view is the 1 Hz topology summary.
FN(foveaProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto o = meterSnapshotToJs(env, b.stream->probe()).As<Napi::Object>();
    const cv::Rect r = b.stream->activeRect();
    o.Set("activeWidth", Napi::Number::New(env, r.width));
    o.Set("activeHeight", Napi::Number::New(env, r.height));
    o.Set("originX", Napi::Number::New(env, r.x));
    o.Set("originY", Napi::Number::New(env, r.y));
    o.Set("undistorted", Napi::Boolean::New(env, b.stream->undistorted()));
    out.Set(pipeId, o);
  }
  return out;
}

// ---- Topology.report() rows (unified-time-and-topology §6) ------------------
// TODO(B-r2): chained-brick input/output types tagged BGRA8/U8 — see the note
// on appendUndistortReports (true for every live chain today).
void appendFoveaReports(Napi::Env env, Napi::Array &rows,
                        std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    // Legacy private chain bricks are REAL nodes — report them (their ids are
    // never advertised pipes, so they stay transport "native").
    if (b.privateConvert)
      appendConvertNodeRow(env, rows, b.privateConvert->name(),
                           b.privateConvert);
    if (b.privateUndistort) {
      auto row = Topology::node(env, b.privateUndistort->name(), "undistort",
                                "native");
      Topology::addInput(env, row, b.privateUndistort->sourceId(), "frame",
                         Topology::frameType(env, "RGBA8", "U8"));
      row.Set("output", Topology::frameType(env, "RGBA8", "U8"));
      row.Set("stats", meterSnapshotToJs(env, b.privateUndistort->probe()));
      rows.Set(rows.Length(), row);
    }
    auto row = Topology::node(env, pipeId, "fovea", "native");
    Topology::addInput(env, row, b.stream->sourceId(), "frame",
                       Topology::frameType(env, "RGBA8", "U8"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "RGBA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
