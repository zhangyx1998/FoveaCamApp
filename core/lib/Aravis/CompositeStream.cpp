// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Composite NAPI seam: the two-input COMPOSITE
// brick — a per-pixel BGRA op (anaglyph / L-vs-R difference) whose two inputs
// are OwnedFrame taps on any convert / undistort / fovea / scale pipe.
//   attachCompositePipe(leftPipeId, rightPipeId, pipeId, params)
//     left/rightPipeId = live convert | undistort | fovea | scale pipe ids.
//     params           = { mode: "anaglyph" | "difference" }.
//   setCompositeParams(pipeId, params)  — reactive, applied on the next frame.
//   detachCompositePipe(pipeId)         — idempotent.
//   compositeProbeAll()                 — meter rows + active out dims + origin.
// The gated `PipeOfferSubscriber` stays MAX-BOUND. The output pipe is
// BGRA8 (like the heatmap). Probe keys AND meter names = the pipeId (= the
// node id). Modelled 1:1 on StereoStream.cpp (SIMPLER: no matcher rebuild).

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "CompositeStream.h"
#include "FoveaStream.h"     // findFovea
#include "ScaleStream.h"     // findScale
#include "UndistortStream.h" // findUndistort

using namespace Napi;

namespace Arv {

// ---- params parse + validate (NAPI thread) --------------------------------
// { mode: "anaglyph" | "difference", style?: "RB"|"RC"|"BR"|"CR" } — optional,
// strings, validated here. `style` mirrors docs/schema/anaglyph.ts and defaults
// to RC (back-compat) when absent.
static CompositeParams parseCompositeParams(const Napi::Object &o) {
  CompositeParams p;
  if (o.Has("mode") && !o.Get("mode").IsUndefined()) {
    if (!o.Get("mode").IsString())
      throw std::invalid_argument("composite params: `mode` must be a string");
    const std::string mode = o.Get("mode").As<Napi::String>().Utf8Value();
    if (mode == "anaglyph")
      p.mode = CompositeMode::Anaglyph;
    else if (mode == "difference")
      p.mode = CompositeMode::Difference;
    else
      throw std::invalid_argument(
          "composite params: `mode` must be \"anaglyph\" or \"difference\"");
  }
  if (o.Has("style") && !o.Get("style").IsUndefined()) {
    if (!o.Get("style").IsString())
      throw std::invalid_argument("composite params: `style` must be a string");
    const std::string style = o.Get("style").As<Napi::String>().Utf8Value();
    if (style == "RB")
      p.style = AnaglyphStyle::RB;
    else if (style == "RC")
      p.style = AnaglyphStyle::RC;
    else if (style == "BR")
      p.style = AnaglyphStyle::BR;
    else if (style == "CR")
      p.style = AnaglyphStyle::CR;
    else
      throw std::invalid_argument(
          "composite params: `style` must be one of \"RB\", \"RC\", \"BR\", "
          "\"CR\"");
  }
  return p;
}

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct CompositeBinding {
  CompositeStream::Ptr stream;                     // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, CompositeBinding> g_pipes;

// Resolve one input pipeId to a live ConvertedFrame producer (undistort /
// convert / fovea / scale). Returns nullptr if none — caller reports the miss.
static ChainedStream::Source resolveSource(const std::string &srcId) {
  if (auto und = findUndistort(srcId))
    return und;
  if (auto conv = findConverter(srcId))
    return conv;
  if (auto fov = findFovea(srcId))
    return fov;
  if (auto sc = findScale(srcId))
    return sc;
  return nullptr;
}

// ---- attach: resolve BOTH sources, register consumer gate ------------------
FN(attachCompositePipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString() && info[1].IsString() && info[2].IsString(),
              TypeError,
              "attachCompositePipe: leftPipeId, rightPipeId, pipeId (strings) "
              "required",
              env.Undefined());
    const auto leftId = info[0].As<Napi::String>().Utf8Value();
    const auto rightId = info[1].As<Napi::String>().Utf8Value();
    const auto pipeId = info[2].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[3].IsObject(), TypeError,
              "attachCompositePipe: params object required", env.Undefined());
    const CompositeParams params =
        parseCompositeParams(info[3].As<Napi::Object>());

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachCompositePipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    ChainedStream::Source left = resolveSource(leftId);
    JS_ASSERT(left != nullptr, Error,
              "attachCompositePipe: no convert/undistort/fovea/scale brick on "
              "LEFT pipe " + leftId,
              env.Undefined());
    ChainedStream::Source right = resolveSource(rightId);
    JS_ASSERT(right != nullptr, Error,
              "attachCompositePipe: no convert/undistort/fovea/scale brick on "
              "RIGHT pipe " + rightId,
              env.Undefined());

    auto stream = CompositeStream::create(std::move(left), leftId,
                                          std::move(right), rightId, pipeId,
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

// ---- live retune: new mode applied on the NEXT frame -----------------------
FN(setCompositeParams) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "setCompositeParams: params object required", env.Undefined());
    const CompositeParams params =
        parseCompositeParams(info[1].As<Napi::Object>());
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
FN(detachCompositePipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    CompositeBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
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
FN(compositeProbeAll) {
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

// ---- Topology.report() rows -------------------------------------------------
// kind "composite" with TWO inputs (ports "left"/"right", BGRA8/U8 from the
// source bricks); output BGRA8/U8 (via decoratePipe fallback).
void appendCompositeReports(Napi::Env env, Napi::Array &rows,
                            std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto row = Topology::node(env, pipeId, "composite", "native");
    Topology::addInput(env, row, b.stream->leftId(), "left",
                       Topology::frameType(env, "RGBA8", "U8"));
    Topology::addInput(env, row, b.stream->rightId(), "right",
                       Topology::frameType(env, "RGBA8", "U8"));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "RGBA8", "U8"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
