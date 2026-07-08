// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <chrono>
#include <map>
#include <mutex>

#include <napi-helper.h>

#include "CaptureSink.h"

// Safe here: this TU never uses an unqualified `Object` (the Aravis headers'
// global `Object` template would otherwise collide with `Napi::Object`).
using namespace Napi;

namespace Arv {

static inline double nowMs() {
  using namespace std::chrono;
  return static_cast<double>(
      duration_cast<milliseconds>(system_clock::now().time_since_epoch())
          .count());
}

bool feedPipe(Pipe::FrameSink &sink, const cv::Mat &raw, PixelFormat format,
              uint64_t deviceTimestamp, uint64_t systemTimestamp, cv::Mat &dst,
              uint32_t expWidth, uint32_t expHeight) {
  // Geometry guard: never offer a frame that mismatches the pipe's advertised
  // bytesPerFrame (size/format change -> A re-advertises a fresh pipe).
  if (static_cast<uint32_t>(raw.cols) != expWidth ||
      static_cast<uint32_t>(raw.rows) != expHeight)
    return false;

  // Convert to BGRA8 into the reusable `dst` (cvtColor reuses dst's allocation
  // when the size/type already match -> no per-frame alloc in steady state).
  const auto t0 = std::chrono::steady_clock::now();
  if (format == BGRA8)
    raw.copyTo(dst); // already BGRA8; still land in the reusable buffer
  else
    cv::cvtColor(raw, dst, cvtColorCode(format, BGRA8));
  const double convertMs =
      std::chrono::duration<double, std::milli>(
          std::chrono::steady_clock::now() - t0)
          .count();

  Pipe::FrameInfo info;
  info.width = static_cast<uint32_t>(dst.cols);
  info.height = static_cast<uint32_t>(dst.rows);
  info.channels = static_cast<uint32_t>(dst.channels()); // 4 (BGRA8)
  info.stride = static_cast<uint32_t>(dst.step);          // bytes/row (may pad)
  // Tight byte count == the ring's bytesPerFrame; the publisher copies
  // row-by-row honoring `stride` into the tight slot.
  info.bytes = static_cast<size_t>(dst.cols) * dst.rows * dst.channels();

  ShmRing::FrameMeta meta;
  meta.tCapture = nowMs();
  meta.convertMs = convertMs;
  meta.deviceTimestamp = deviceTimestamp;
  meta.systemTimestamp = systemTimestamp;

  sink.offer(dst.data, info, meta);
  return true;
}

// ---- attachCameraPipe cut-over seam (B-17 Part 1) ------------------------
// A's registry (JS) calls attachCameraPipe(camera, pipeId) on pipe-connect and
// detachCameraPipe(pipeId) on disconnect. We keep the CaptureSink alive in a
// B-owned registry keyed by pipeId (1:1 producer↔pipe); detach drops the Ptr,
// which unsubscribes the capture subscriber and pauses the Stream thread if it
// had no other subscribers. `camera` MUST be A's shared lease handle — Aravis
// is per-process exclusive, so `Stream::get(camera)` reuses the one stream the
// preview/vision taps already share (never opens a second consumer).
static std::mutex g_sinksMutex;
static std::map<std::string, CaptureSink::Ptr> g_sinks;

FN(attachCameraPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    auto *sink = Pipe::PipeHub::instance().sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachCameraPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = Pipe::PipeHub::instance().publisher(pipeId).spec();
    auto captureSink =
        CaptureSink::create(Arv::Stream::get(camera), sink, spec.width, spec.height);
    {
      std::scoped_lock lock(g_sinksMutex);
      g_sinks[pipeId] = captureSink; // replaces any prior binding for this pipe
    }
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

FN(detachCameraPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    CaptureSink::Ptr removed; // dropped AFTER the lock (unsubscribe may block)
    {
      std::scoped_lock lock(g_sinksMutex);
      auto it = g_sinks.find(pipeId);
      if (it != g_sinks.end()) {
        removed = it->second;
        g_sinks.erase(it);
      }
    }
    return Boolean::New(env, removed != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// Test-only: enable Aravis's built-in fake camera interface so the attach path
// can be driven end-to-end (real Arv::Stream, synthetic frames) with no
// hardware — see core/test/11-capture-pipe.ts.
FN(enableFakeCamera) {
  auto env = info.Env();
  arv_enable_interface("Fake");
  return env.Undefined();
}

// ---- no-hardware loopback test hook (B-16 Phase 2) -----------------------
// Synthesize a uniform source frame in `srcFormat` at the pipe's advertised
// size and run it through the REAL convert+offer path into C's pipe ring — so
// core/test/11-capture-pipe.ts can verify the seam end-to-end (advertise ->
// feed -> reader) with no camera. `feedTestFrame(pipeId, srcFormat, fill)` ->
// bool offered.
FN(feedTestFrame) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    const auto srcName = info[1].As<Napi::String>().Utf8Value();
    const auto fill = static_cast<uint8_t>(info[2].As<Napi::Number>().Uint32Value());

    auto *sink = Pipe::PipeHub::instance().sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "unknown pipe: " + pipeId,
              env.Undefined());
    const auto &spec = Pipe::PipeHub::instance().publisher(pipeId).spec();

    const auto format = convert<PixelFormat>(srcName);
    cv::Mat raw(static_cast<int>(spec.height), static_cast<int>(spec.width),
                convert<cv::Format>(format), cv::Scalar::all(fill));
    cv::Mat dst;
    const bool offered =
        feedPipe(*sink, raw, format, /*deviceTs*/ fill,
                 /*systemTs*/ static_cast<uint64_t>(fill) * 1000, dst,
                 spec.width, spec.height);
    return Boolean::New(env, offered);
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Arv
