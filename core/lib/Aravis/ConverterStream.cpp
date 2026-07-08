// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 real-1e (B-18) NAPI seam: attach/detach a camera→pipe CONVERTER thread,
// plus the no-hardware `feedTestFrame` hook and the converter meter probe. The
// per-pipe binding holds a persistent `ConverterStream` (per camera × target
// format) and a GATED `PipeOfferSubscriber` whose lifetime C's consumer gate
// drives (subscribe when a consumer connects → wakes the converter; unsubscribe
// when they drain → converter auto-parks). Retires the inline-convert path.

#include <functional>
#include <map>
#include <memory>
#include <mutex>

#include <napi-helper.h>

#include "ConverterStream.h"

using namespace Napi;

namespace Arv {

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
struct PipeBinding {
  ConverterStream::Ptr converter;               // persists across gate toggles
  std::unique_ptr<PipeOfferSubscriber> subscriber; // gated lifetime (destructs first)
  Pipe::FrameSink *sink = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
};

static std::mutex g_mutex;
static std::map<std::string, PipeBinding> g_pipes;

// ---- Meter::Snapshot -> JS (per-pipe converter probe, for perfSnapshot) ---
static Napi::Object statsToJs(Napi::Env env,
                              const std::vector<std::pair<std::string, Meter::StreamStat>> &v) {
  auto m = Napi::Object::New(env);
  for (const auto &[k, st] : v) {
    auto so = Napi::Object::New(env);
    so.Set("count", Napi::Number::New(env, static_cast<double>(st.count)));
    so.Set("ratePerSec", Napi::Number::New(env, st.ratePerSec));
    so.Set("maxIntervalMs", Napi::Number::New(env, st.maxIntervalMs));
    m.Set(k, so);
  }
  return m;
}
static Napi::Value snapshotToJs(Napi::Env env, const Meter::Snapshot &s) {
  auto o = Napi::Object::New(env);
  o.Set("name", Napi::String::New(env, s.name));
  o.Set("uptimeMs", Napi::Number::New(env, static_cast<double>(s.uptimeMs)));
  o.Set("utilization", Napi::Number::New(env, s.utilization));
  o.Set("busyMs", Napi::Number::New(env, s.busyMs));
  o.Set("dropTotal", Napi::Number::New(env, static_cast<double>(s.dropTotal)));
  o.Set("inputs", statsToJs(env, s.inputs));
  o.Set("outputs", statsToJs(env, s.outputs));
  return o;
}

// ---- attach: build the converter, gate the pipe subscriber ----------------
FN(attachCameraPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachCameraPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // The advertised pixelFormat IS the converter selector (src = frame->format
    // at convert time). Aravis exclusivity honored via the shared Stream::get.
    const PixelFormat target = convert<PixelFormat>(spec.pixelFormat);
    auto converter = ConverterStream::create(Arv::Stream::get(camera), target);
    {
      std::scoped_lock lock(g_mutex);
      auto &b = g_pipes[pipeId];
      b.converter = converter;
      b.sink = sink;
      b.width = spec.width;
      b.height = spec.height;
      b.subscriber.reset(); // the gate (re)creates it per consumer presence
    }
    // Register the gate OUTSIDE the lock: it fires immediately with the current
    // consumer state (creating the subscriber if a consumer is already
    // connected), which re-locks g_mutex.
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end())
        return;
      auto &b = it->second;
      if (active && !b.subscriber)
        b.subscriber = std::make_unique<PipeOfferSubscriber>(
            b.converter.get(), b.sink, b.width, b.height);
      else if (!active && b.subscriber)
        b.subscriber.reset();
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding -------------
FN(detachCameraPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    // Clear the gate before touching the registry so no edge fires into freed
    // state (both are NAPI-thread).
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    PipeBinding removed; // destructed OUTSIDE the lock (subscriber unsubscribe +
                         // converter shutdown/join may block)
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end()) {
        removed = std::move(it->second);
        g_pipes.erase(it);
      }
    }
    return Boolean::New(env, removed.converter != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- per-pipeId converter meter snapshots (A-25 → perfSnapshot.workloads) --
FN(converterProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes)
    if (b.converter)
      out.Set(pipeId, snapshotToJs(env, b.converter->probe()));
  return out;
}

// ---- no-hardware loopback hook: synthesize a source frame, convert, offer --
FN(feedTestFrame) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    const auto srcName = info[1].As<Napi::String>().Utf8Value();
    const auto fill = static_cast<uint8_t>(info[2].As<Napi::Number>().Uint32Value());
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "feedTestFrame: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const PixelFormat src = convert<PixelFormat>(srcName);
    const PixelFormat dst = convert<PixelFormat>(spec.pixelFormat);
    cv::Mat raw(static_cast<int>(spec.height), static_cast<int>(spec.width),
                convert<cv::Format>(src), cv::Scalar::all(fill));
    cv::Mat out;
    convertFrame(raw, src, dst, out); // the SHARED converter (incl. down-scale)
    if (static_cast<uint32_t>(out.cols) != spec.width ||
        static_cast<uint32_t>(out.rows) != spec.height)
      return Boolean::New(env, false);
    Pipe::FrameInfo fi;
    fi.width = static_cast<uint32_t>(out.cols);
    fi.height = static_cast<uint32_t>(out.rows);
    fi.channels = static_cast<uint32_t>(out.channels());
    fi.stride = static_cast<uint32_t>(out.step);
    fi.bytes = static_cast<size_t>(out.cols) * out.rows * out.channels();
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(converterNowMs());
    meta.deviceTimestamp = fill;
    meta.systemTimestamp = static_cast<uint64_t>(fill) * 1000;
    sink->offer(out.data, fi, meta);
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// Test-only: enable Aravis's built-in fake camera (see 11-capture-pipe.ts).
FN(enableFakeCamera) {
  auto env = info.Env();
  arv_enable_interface("Fake");
  return env.Undefined();
}

} // namespace Arv
