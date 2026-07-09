// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// stereo-disparity-and-heatmap-nodes §"StereoStream (pinned)" NAPI seam: the
// FIRST two-input chained brick — a cv::StereoSGBM disparity producer whose two
// inputs are OwnedFrame taps on any convert / undistort / fovea / scale pipe.
//   attachStereoPipe(leftPipeId, rightPipeId, pipeId, params)
//     left/rightPipeId = live convert | undistort | fovea | scale pipe ids.
//     params           = { numDisparities?, blockSize?, minDisparity? }.
//   setStereoParams(pipeId, params)  — reactive, matcher rebuilt on next frame.
//   detachStereoPipe(pipeId)         — idempotent.
//   stereoProbeAll()                 — meter rows + active out dims + origin.
// The gated `PipeOfferSubscriber` stays MAX-BOUND (C-20). The output pipe is
// CV_32FC1 disparity (Disparity32F / F32). Probe keys AND meter names = the
// pipeId (= C-24 node id). Modelled 1:1 on ScaleStream.cpp.

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "FoveaStream.h"     // findFovea
#include "ScaleStream.h"     // findScale
#include "StereoStream.h"
#include "UndistortStream.h" // findUndistort

using namespace Napi;

namespace Arv {

// ---- params parse + validate (NAPI thread) --------------------------------
// numDisparities rounded UP to a multiple of 16 (min 16, default 128);
// blockSize forced odd (min 1, default 5); minDisparity default 0.
static StereoParams parseStereoParams(const Napi::Object &o) {
  StereoParams p;
  if (o.Has("numDisparities") && !o.Get("numDisparities").IsUndefined()) {
    const double v = o.Get("numDisparities").As<Napi::Number>().DoubleValue();
    if (!(v >= 1) || !std::isfinite(v))
      throw std::invalid_argument("stereo params: `numDisparities` must be >= 1");
    int n = static_cast<int>(std::lround(v));
    n = ((n + 15) / 16) * 16; // round UP to a multiple of 16
    p.numDisparities = std::max(16, n);
  }
  if (o.Has("blockSize") && !o.Get("blockSize").IsUndefined()) {
    const double v = o.Get("blockSize").As<Napi::Number>().DoubleValue();
    if (!(v >= 1) || !std::isfinite(v))
      throw std::invalid_argument("stereo params: `blockSize` must be >= 1");
    int b = static_cast<int>(std::lround(v));
    if ((b & 1) == 0)
      b += 1; // force odd
    p.blockSize = std::max(1, b);
  }
  if (o.Has("minDisparity") && !o.Get("minDisparity").IsUndefined()) {
    const double v = o.Get("minDisparity").As<Napi::Number>().DoubleValue();
    if (!std::isfinite(v))
      throw std::invalid_argument("stereo params: `minDisparity` must be finite");
    p.minDisparity = static_cast<int>(std::lround(v));
  }
  return p;
}

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct StereoBinding {
  StereoStream::Ptr stream;                        // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t maxW = 0;
  uint32_t maxH = 0;
};

static std::mutex g_mutex;
static std::map<std::string, StereoBinding> g_pipes;

StereoStream::Ptr findStereo(const std::string &pipeId) {
  std::scoped_lock lock(g_mutex);
  auto it = g_pipes.find(pipeId);
  return it != g_pipes.end() ? it->second.stream : nullptr;
}

// Resolve one input pipeId to a live ConvertedFrame producer (undistort /
// convert / fovea / scale). Returns nullptr if none — caller reports the miss.
// Also resolves a pairing test source (test-only; the registry is empty in
// production, same precedent as PairStream's resolvePairSource) so the paired
// core test can drive a latest-wins parity reference off the same frames.
static ChainedStream::Source resolveSource(const std::string &srcId) {
  if (auto und = findUndistort(srcId))
    return und;
  if (auto conv = findConverter(srcId))
    return conv;
  if (auto fov = findFovea(srcId))
    return fov;
  if (auto sc = findScale(srcId))
    return sc;
  if (auto t = findPairTestSource(srcId))
    return t;
  return nullptr;
}

// ---- attach: resolve BOTH sources, register consumer gate ------------------
FN(attachStereoPipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString() && info[1].IsString() && info[2].IsString(),
              TypeError,
              "attachStereoPipe: leftPipeId, rightPipeId, pipeId (strings) "
              "required",
              env.Undefined());
    const auto leftId = info[0].As<Napi::String>().Utf8Value();
    const auto rightId = info[1].As<Napi::String>().Utf8Value();
    const auto pipeId = info[2].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[3].IsObject(), TypeError,
              "attachStereoPipe: params object required", env.Undefined());
    const StereoParams params = parseStereoParams(info[3].As<Napi::Object>());

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachStereoPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    ChainedStream::Source left = resolveSource(leftId);
    JS_ASSERT(left != nullptr, Error,
              "attachStereoPipe: no convert/undistort/fovea/scale brick on "
              "LEFT pipe " + leftId,
              env.Undefined());
    ChainedStream::Source right = resolveSource(rightId);
    JS_ASSERT(right != nullptr, Error,
              "attachStereoPipe: no convert/undistort/fovea/scale brick on "
              "RIGHT pipe " + rightId,
              env.Undefined());

    auto stream =
        StereoStream::create(std::move(left), leftId, std::move(right), rightId,
                             pipeId, params, maxW, maxH);
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

// ---- attach PAIRED: SGBM per exposure pair off the pair brick ---------------
// stereo-paired-inputs: the trigger-mode variant. ONE input = a live pairing
// brick (`pair/<stage>`, e.g. `pair/undistort`); records carry matched L/R
// frames. Same output pipe (Disparity32F / F32, left-sized), same consumer gate
// (on-demand), same reactive params + probe surface as attachStereoPipe.
FN(attachStereoPaired) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString() && info[1].IsString(), TypeError,
              "attachStereoPaired: pairStage, pipeId (strings) required",
              env.Undefined());
    const auto pairStage = info[0].As<Napi::String>().Utf8Value();
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[2].IsObject(), TypeError,
              "attachStereoPaired: params object required", env.Undefined());
    const StereoParams params = parseStereoParams(info[2].As<Napi::Object>());

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachStereoPaired: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    PairStream::Ptr pair = findPair(pairStage);
    JS_ASSERT(pair != nullptr, Error,
              "attachStereoPaired: no pairing brick on stage " + pairStage,
              env.Undefined());

    auto stream = StereoStream::createPaired(
        std::static_pointer_cast<::Stream<PairBatch::Ptr>>(pair), pairStage,
        pipeId, params, maxW, maxH);
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

// ---- live retune: new SGBM params applied on the NEXT frame ----------------
FN(setStereoParams) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    JS_ASSERT(info[1].IsObject(), TypeError,
              "setStereoParams: params object required", env.Undefined());
    const StereoParams params = parseStereoParams(info[1].As<Napi::Object>());
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
FN(detachStereoPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    StereoBinding removed; // destructed OUTSIDE the lock (unsubscribe + join)
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
FN(stereoProbeAll) {
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
    o.Set("paired", Napi::Boolean::New(env, b.stream->paired()));
    o.Set("pairDrops",
          Napi::Number::New(env, static_cast<double>(b.stream->pairDrops())));
    out.Set(pipeId, o);
  }
  return out;
}

// ---- Topology.report() rows (unified-time-and-topology §6) ------------------
// kind "stereo" with TWO inputs (ports "left"/"right", BGRA8/U8 from the source
// bricks); output CV_32F disparity (Disparity32F / F32).
void appendStereoReports(Napi::Env env, Napi::Array &rows,
                         std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b.stream)
      continue;
    auto row = Topology::node(env, pipeId, "stereo", "native");
    if (b.stream->paired()) {
      // stereo-paired-inputs: ONE edge from the pair node (`pair/<stage>` →
      // `stereo/<name>`); the pair record carries the matched L/R frames.
      Topology::addInput(env, row, b.stream->pairFrom(), "pair",
                         Topology::frameType(env, "BGRA8", "U8"));
    } else {
      Topology::addInput(env, row, b.stream->leftId(), "left",
                         Topology::frameType(env, "BGRA8", "U8"));
      Topology::addInput(env, row, b.stream->rightId(), "right",
                         Topology::frameType(env, "BGRA8", "U8"));
    }
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, "Disparity32F", "F32"));
    row.Set("stats", meterSnapshotToJs(env, b.stream->probe()));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
