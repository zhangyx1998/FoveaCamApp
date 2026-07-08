// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// real-2 (B-24) NAPI seam: spawn/cancel-able fovea crop pipes. Mirrors the
// B-18/B-23 attach pattern; the binding holds a persistent `FoveaStream`
// (camera × spec.pixelFormat × live rect, optional calibration ⇒ undistorted
// crop) and a GATED `PipeOfferSubscriber` in MAX-BOUND mode (per-frame active
// w/h ≤ the advertised max footprint — C-20 slot-header semantics). Spawn =
// advertise + attach + connect; cancel = disconnect + detach + close + drop;
// the broker's per-id epochs make churned ids reuse-safe. `setFoveaRect`
// steers the crop live (applied next frame) — no re-attach, no gate churn.
// Probe keys AND meter names = the pipeId (= C-24 node id).

#include <map>
#include <memory>
#include <mutex>

#include <napi-helper.h>

#include "FoveaStream.h"

using namespace Napi;

namespace Arv {

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct FoveaBinding {
  FoveaStream::Ptr stream;                         // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, FoveaBinding> g_pipes;

// ---- attach: build the fovea thread (maps if calibrated), gate the offer ---
FN(attachFoveaPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachFoveaPipe: options object required", env.Undefined());
    const auto opts = info[2].As<Napi::Object>();
    const auto rect = convert<cv::Rect>(opts.Get("rect"));
    // Optional plain persisted CameraCalibration JSON ⇒ undistorted crop
    // (B-23 ruling 1: never the env-bound Vision `Undistort` instance).
    CameraCalibration::Ptr cal = nullptr;
    if (opts.Has("cal") && !opts.Get("cal").IsUndefined() &&
        !opts.Get("cal").IsNull())
      cal = convert<CameraCalibration::Ptr>(opts.Get("cal"));
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachFoveaPipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const PixelFormat target = convert<PixelFormat>(spec.pixelFormat);
    // C-20 footprint cap: the ring is sized to max (defaults to nominal).
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;
    auto stream = FoveaStream::create(Arv::Stream::get(camera), target, pipeId,
                                      rect, cal, maxW, maxH);
    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      b.subscriber.reset(); // re-attach: gated sub points at the old stream
      b.stream = std::move(stream);
      b.sink = sink;
      b.maxW = maxW;
      b.maxH = maxH;
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

} // namespace Arv
