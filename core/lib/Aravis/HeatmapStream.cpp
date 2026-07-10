// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// stereo-disparity-and-heatmap-nodes §"HeatmapStream (pinned)" NAPI seam:
// spawn/cancel-able colormap pipes, chained on a stereo disparity pipe (or any
// convert / undistort / fovea / scale pipe's OwnedFrame tap). Colormaps a
// 1-channel input (CV_32FC1 or CV_8UC1) through COLORMAP_TURBO → BGRA8.
//   attachHeatmapPipe(sourcePipeId, pipeId, params)
//     sourcePipeId = a live stereo | convert | undistort | fovea | scale pipe.
//     params       = { min?, max? } (each independent; absent → per-frame auto).
//   setHeatmapParams(pipeId, params)  — reactive, applied on the NEXT frame.
//   detachHeatmapPipe(pipeId)         — idempotent.
//   heatmapProbeAll()                 — meter rows + active out dims + origin.
// Modelled 1:1 on ScaleStream.cpp. Source resolution: findStereo FIRST.

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "FoveaStream.h"     // findFovea
#include "HeatmapStream.h"
#include "ScaleStream.h"     // findScale
#include "StereoStream.h"    // findStereo
#include "UndistortStream.h" // findUndistort

using namespace Napi;

namespace Arv {

// ---- params parse (NAPI thread) -------------------------------------------
// { min?, max? } — each field independent; an absent field stays auto (derived
// per frame from minMaxLoc on the brick thread).
static HeatmapParams parseHeatmapParams(const Napi::Object &o) {
  HeatmapParams p;
  if (o.Has("min") && !o.Get("min").IsUndefined()) {
    const double v = o.Get("min").As<Napi::Number>().DoubleValue();
    if (!std::isfinite(v))
      throw std::invalid_argument("heatmap params: `min` must be finite");
    p.hasMin = true;
    p.min = v;
  }
  if (o.Has("max") && !o.Get("max").IsUndefined()) {
    const double v = o.Get("max").As<Napi::Number>().DoubleValue();
    if (!std::isfinite(v))
      throw std::invalid_argument("heatmap params: `max` must be finite");
    p.hasMax = true;
    p.max = v;
  }
  return p;
}

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct HeatmapBinding {
  HeatmapStream::Ptr stream;                       // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, HeatmapBinding> g_pipes;

HeatmapStream::Ptr findHeatmap(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// ---- attach: resolve the source brick (stereo first), gate -----------------
FN(attachHeatmapPipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "attachHeatmapPipe: sourcePipeId (string) required",
              env.Undefined());
    const auto srcId = info[0].As<Napi::String>().Utf8Value();
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachHeatmapPipe: params object required", env.Undefined());
    const HeatmapParams params = parseHeatmapParams(info[2].As<Napi::Object>());

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachHeatmapPipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    // Source resolution: findStereo FIRST, then the frame families.
    ChainedStream::Source source;
    if (auto st = findStereo(srcId))
      source = st;
    else if (auto und = findUndistort(srcId))
      source = und;
    else if (auto conv = findConverter(srcId))
      source = conv;
    else if (auto fov = findFovea(srcId))
      source = fov;
    else if (auto sc = findScale(srcId))
      source = sc;
    else
      JS_THROW(Error,
               "attachHeatmapPipe: no stereo/convert/undistort/fovea/scale "
               "brick on pipe " + srcId,
               env.Undefined());

    auto stream = HeatmapStream::create(std::move(source), srcId, pipeId,
                                        params, maxW, maxH);
    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      b.subscriber.reset(); // re-attach: gated sub points at the old stream
      b.stream = std::move(stream);
      b.sink = sink;
      b.maxW = maxW;
      b.maxH = maxH;
    }
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
FN(setHeatmapParams) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "setHeatmapParams: params object required", env.Undefined());
    const HeatmapParams params = parseHeatmapParams(info[1].As<Napi::Object>());
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
FN(detachHeatmapPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    HeatmapBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
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
FN(heatmapProbeAll) {
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
// kind "heatmap"; input from the source brick id; output BGRA8/U8.
void appendHeatmapReports(Napi::Env env, Napi::Array &rows,
                          std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto row = Topology::node(env, pipeId, "heatmap", "native");
    Topology::addInput(env, row, b.stream->sourceId(), "frame",
                       Topology::frameType(env, "Disparity32F", "F32"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "RGBA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
