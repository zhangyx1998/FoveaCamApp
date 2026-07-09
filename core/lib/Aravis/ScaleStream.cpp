// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// split-disparity-nodes §"Scale node = a NEW native chained brick" NAPI seam:
// spawn/cancel-able RESIZE pipes, chained on any convert / undistort / fovea /
// scale pipe's OwnedFrame tap (Leaky/latest-wins input, demand propagation
// keeps the upstream chain awake). Modelled 1:1 on FoveaStream.cpp:
//   attachScalePipe(sourcePipeId, pipeId, params)
//     sourcePipeId = a live convert | undistort | fovea | scale pipe id.
//     params       = EXACTLY one of {ratio}|{dwidth}|{dheight}|{dsize:{w,h}}.
//   setScaleParams(pipeId, params)  — reactive, applied on the NEXT frame.
//   detachScalePipe(pipeId)         — idempotent.
//   scaleProbeAll()                 — meter rows + active out dims + origin.
// The gated `PipeOfferSubscriber` stays MAX-BOUND (C-20: per-frame active out
// w/h ≤ the advertised max footprint, forwarded crop origin in the v4 slot
// header). Probe keys AND meter names = the pipeId (= C-24 node id).

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "FoveaStream.h"      // findFovea (chain on a fovea/slice pipe)
#include "ScaleStream.h"
#include "UndistortStream.h"  // findUndistort

using namespace Napi;

namespace Arv {

// ---- params parse + validate (NAPI thread) --------------------------------
// EXACTLY one of {ratio}|{dwidth}|{dheight}|{dsize:{width,height}}. Throws
// std::invalid_argument (→ JS Error via JS_EXCEPT) on missing/ambiguous/invalid.
static ScaleParams parseScaleParams(const Napi::Object &o) {
  const bool hasRatio = o.Has("ratio") && !o.Get("ratio").IsUndefined();
  const bool hasDw = o.Has("dwidth") && !o.Get("dwidth").IsUndefined();
  const bool hasDh = o.Has("dheight") && !o.Get("dheight").IsUndefined();
  const bool hasDs = o.Has("dsize") && !o.Get("dsize").IsUndefined();
  const int n = int(hasRatio) + int(hasDw) + int(hasDh) + int(hasDs);
  if (n != 1)
    throw std::invalid_argument(
        "scale params: provide EXACTLY one of {ratio}|{dwidth}|{dheight}|"
        "{dsize:{width,height}} (got " + std::to_string(n) + ")");
  ScaleParams p;
  if (hasRatio) {
    p.mode = ScaleParams::Mode::Ratio;
    p.ratio = o.Get("ratio").As<Napi::Number>().DoubleValue();
    if (!(p.ratio > 0) || !std::isfinite(p.ratio))
      throw std::invalid_argument("scale params: `ratio` must be > 0");
  } else if (hasDw) {
    p.mode = ScaleParams::Mode::DWidth;
    const double w = o.Get("dwidth").As<Napi::Number>().DoubleValue();
    if (!(w >= 1) || !std::isfinite(w))
      throw std::invalid_argument("scale params: `dwidth` must be >= 1");
    p.width = static_cast<uint32_t>(std::lround(w));
  } else if (hasDh) {
    p.mode = ScaleParams::Mode::DHeight;
    const double h = o.Get("dheight").As<Napi::Number>().DoubleValue();
    if (!(h >= 1) || !std::isfinite(h))
      throw std::invalid_argument("scale params: `dheight` must be >= 1");
    p.height = static_cast<uint32_t>(std::lround(h));
  } else {
    if (!o.Get("dsize").IsObject())
      throw std::invalid_argument("scale params: `dsize` must be {width,height}");
    p.mode = ScaleParams::Mode::DSize;
    const auto ds = o.Get("dsize").As<Napi::Object>();
    const double w = ds.Has("width") ? ds.Get("width").As<Napi::Number>().DoubleValue() : 0;
    const double h = ds.Has("height") ? ds.Get("height").As<Napi::Number>().DoubleValue() : 0;
    if (!(w >= 1) || !(h >= 1) || !std::isfinite(w) || !std::isfinite(h))
      throw std::invalid_argument(
          "scale params: `dsize.width`/`dsize.height` must be >= 1");
    p.width = static_cast<uint32_t>(std::lround(w));
    p.height = static_cast<uint32_t>(std::lround(h));
  }
  return p;
}

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct ScaleBinding {
  ScaleStream::Ptr stream;                         // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, ScaleBinding> g_pipes;

ScaleStream::Ptr findScale(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// ---- attach: resolve the source brick (any ConvertedFrame producer), gate --
FN(attachScalePipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "attachScalePipe: sourcePipeId (string) required", env.Undefined());
    const auto srcId = info[0].As<Napi::String>().Utf8Value();
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachScalePipe: params object required", env.Undefined());
    const ScaleParams params = parseScaleParams(info[2].As<Napi::Object>());

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachScalePipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // C-20 footprint cap: the ring is sized to max (defaults to nominal).
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    // Resolve the tap SOURCE by pipeId: any live ConvertedFrame producer —
    // undistort, convert, fovea/slice, or another scale (findUndistort first;
    // ids never collide across families, so order is cosmetic).
    ChainedStream::Source source;
    if (auto und = findUndistort(srcId))
      source = und;
    else if (auto conv = findConverter(srcId))
      source = conv;
    else if (auto fov = findFovea(srcId))
      source = fov;
    else if (auto sc = findScale(srcId))
      source = sc;
    else
      JS_THROW(Error,
               "attachScalePipe: no convert/undistort/fovea/scale brick on "
               "pipe " + srcId,
               env.Undefined());

    auto stream = ScaleStream::create(std::move(source), srcId, pipeId, params,
                                      maxW, maxH);
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

// ---- live retune: new params applied on the NEXT frame ---------------------
FN(setScaleParams) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "setScaleParams: params object required", env.Undefined());
    const ScaleParams params = parseScaleParams(info[1].As<Napi::Object>());
    std::scoped_lock lock(g_mutex);
    auto it = g_pipes.find(pipeId);
    if (it == g_pipes.end() || !it->second.stream)
      return Boolean::New(env, false);
    it->second.stream->setParams(params);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachScalePipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    ScaleBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
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

// ---- probes: keyed by pipeId (= node id), meter name == key ----------------
// Extra fields: the active OUT dims (activeWidth/activeHeight) of the LAST
// produced frame + its forwarded crop origin (source full-res coords). The
// authoritative per-frame values ride each frame's v4 slot header; this probe
// view is the 1 Hz topology summary (mirrors foveaProbeAll).
FN(scaleProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto o = meterSnapshotToJs(env, b.stream->probe()).As<Napi::Object>();
    const cv::Rect r = b.stream->activeRect(); // {originX, originY, w, h}
    o.Set("activeWidth", Napi::Number::New(env, r.width));
    o.Set("activeHeight", Napi::Number::New(env, r.height));
    o.Set("originX", Napi::Number::New(env, r.x));
    o.Set("originY", Napi::Number::New(env, r.y));
    out.Set(pipeId, o);
  }
  return out;
}

// ---- Topology.report() rows (unified-time-and-topology §6) ------------------
void appendScaleReports(Napi::Env env, Napi::Array &rows,
                        std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto row = Topology::node(env, pipeId, "scale", "native");
    Topology::addInput(env, row, b.stream->sourceId(), "frame",
                       Topology::frameType(env, "BGRA8", "U8"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "BGRA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
