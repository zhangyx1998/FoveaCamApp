// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 real-1g (B-23) NAPI seam: attach/detach a camera→pipe UNDISTORT thread +
// its meter probe, mirroring the real-1e converter seam. The per-pipe binding
// holds a persistent `UndistortStream` (camera × spec.pixelFormat, maps built
// at attach from the plain persisted CameraCalibration JSON) and a GATED
// `PipeOfferSubscriber` whose lifetime the pipe's OWN connectPipe refcount
// drives via `setConsumerGate` (subscribe on first consumer → wakes the
// thread; unsubscribe on drain → auto-parks). B stays pipe-id-agnostic: the
// `undistort:<serial>[@<format>]` naming is A/C's contract layer; the format
// modifier is read from `spec.pixelFormat` exactly like raw pipes.

#include <map>
#include <memory>
#include <mutex>

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
};

static std::mutex g_mutex;
static std::map<std::string, UndistortBinding> g_pipes;

// ---- attach: build maps + the undistort thread, gate the pipe subscriber ---
FN(attachUndistortPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    // The PLAIN persisted CameraCalibration JSON (sensor_size/camera_matrix/
    // dist_coeffs/...) — never the env-bound Vision `Undistort` instance
    // (B-23 ruling #1). Maps are built natively in the stream ctor.
    auto cal = convert<CameraCalibration::Ptr>(info[2]);
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachUndistortPipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // spec.pixelFormat IS the access modifier, exactly like raw pipes.
    const PixelFormat target = convert<PixelFormat>(spec.pixelFormat);
    auto stream =
        UndistortStream::create(Arv::Stream::get(camera), target, cal, pipeId);
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

// ---- per-pipeId undistort meter snapshots (perfSnapshot.workloads sibling) --
FN(undistortProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes)
    if (b.stream)
      out.Set(pipeId, meterSnapshotToJs(env, b.stream->probe()));
  return out;
}

} // namespace Arv
