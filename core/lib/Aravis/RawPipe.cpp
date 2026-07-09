// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 1: RAW camera pipes. The `PipeOfferSubscriber`
// pattern (see ConverterStream.h) applied to the camera SOURCE stream instead
// of a converted-frame producer — the recorder/capture nodes need full-bit-
// depth sensor bytes, NOT the 8-bit down-scaled BGRA8 preview pipes.
//
//   attachRawPipe(camera, pipeId)  — subscribe a gated raw producer to the
//                                    camera's Arv::Stream; offer `frame->raw`.
//   detachRawPipe(pipeId)          — idempotent (unregister gate + drop binding).
//   rawProbeAll()                  — per-pipe ingest/offer meter rows.
//
// The subscriber runs on the camera CAPTURE thread, in the Stream base's
// synchronous fan-out: it extracts `frame->raw` and copies it into the ring
// (`sink->offer`) BEFORE the Frame is released — the hard "extract before
// release" invariant is satisfied by the synchronous dispatch (the Frame::Ptr
// is alive for the whole push). CONSUMER-GATED (C-21): no recorder/capture
// attached → the subscriber does not exist → zero capture-thread cost.
//
// NOTE (12p): `Arv::Frame` UNPACKS packed 12p into a 16-bit (CV_16UC1)
// container at construction (Frame.h `fromArvBuffer`), then Stream.cpp
// immediately recycles the ArvBuffer — so by the time ANY Frame::Ptr
// subscriber runs, the literally-packed bytes are already gone. The raw pipe
// therefore carries `frame->raw` = the FULL-BIT-DEPTH container (16-bit for
// 12p/Mono16, 8-bit for Mono8), which is exactly what the recorder needs
// (full depth, not the preview). `pixelFormat` = the sensor format string;
// `dtype` (U8/U16) follows the container width. Truly-packed preservation
// would require a pre-Frame ArvBuffer tap in Stream::iterate() — out of scope.

#include <map>
#include <memory>
#include <mutex>

#include <Topology.h>
#include <napi-helper.h>

#include "ConverterStream.h" // converterNowMs, meterSnapshotToJs, PipeOfferSubscriber precedent
#include "Stream.h"          // Arv::Stream, Arv::Frame

using namespace Napi;

namespace Arv {

// The raw producer: a DIRECT synchronous-consume Subscriber on the camera's
// Arv::Stream (a `Stream<Frame::Ptr>`). Mirrors PipeOfferSubscriber, but the
// input is a raw `Frame` and it publishes `frame->raw` bytes verbatim. MUST
// stay a plain Subscriber (not Latest/Queue) so the reused-buffer/before-release
// contract holds: `offer()` copies into the ring inline, before the fan-out
// releases the Frame.
class RawPipeSubscriber : public Subscriber<Frame::Ptr> {
public:
  RawPipeSubscriber(::Stream<Frame::Ptr> *producer, Pipe::FrameSink *sink,
                    uint32_t maxW, uint32_t maxH, Meter::ThreadMeter *meter)
      : Subscriber<Frame::Ptr>(producer), sink_(sink), maxW_(maxW), maxH_(maxH),
        meter_(meter) {}
  ~RawPipeSubscriber() { close(); } // unsubscribe before the source releases

protected:
  void push(const Frame::Ptr &frame) override {
    if (!frame || !sink_)
      return;
    const cv::Mat &m = frame->raw; // sensor container (full bit depth)
    const auto w = static_cast<uint32_t>(m.cols);
    const auto h = static_cast<uint32_t>(m.rows);
    const int64_t t = converterNowMs();
    // Fixed-geometry guard: a camera pipe's active size must fit the advertised
    // max footprint (a resolution change ⇒ the session re-advertises).
    if (w == 0 || h == 0 || w > maxW_ || h > maxH_) {
      if (meter_)
        meter_->drop();
      return;
    }
    if (meter_)
      meter_->ingest("frame", t);
    if (meter_)
      meter_->begin(t);
    Pipe::FrameInfo info;
    info.width = w;
    info.height = h;
    info.channels = static_cast<uint32_t>(m.channels());
    info.stride = static_cast<uint32_t>(m.step);
    // Bytes per channel element (1 for Mono8/Bayer8, 2 for Mono16/12p→16-bit) —
    // the publisher's tight-packed row math multiplies by it so a >8-bit
    // container publishes uncorrupted.
    info.bytesPerElement = static_cast<uint32_t>(m.elemSize1());
    info.bytes = static_cast<size_t>(m.cols) * m.rows * m.channels() *
                 m.elemSize1();
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(t);
    // Owner-applied calibrated device time + host system time (trusted-time:
    // timestamps between nodes are always trusted — never restamped here).
    meta.deviceTimestamp = frame->device_timestamp;
    meta.systemTimestamp = frame->system_timestamp;
    sink_->offer(m.data, info, meta); // synchronous copy into the ring
    if (meter_) {
      const int64_t done = converterNowMs(); // one clock read, not two
      meter_->end(done);
      meter_->emit("shm", done);
    }
  }

private:
  Pipe::FrameSink *const sink_;
  const uint32_t maxW_, maxH_;
  Meter::ThreadMeter *const meter_; // owned by the binding; single writer here
};

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) -------------
// Held by unique_ptr: `Arv::Stream::Ptr` (a RefCount::Reference) has neither a
// default nor a copy-assignment operator, so the binding can't be a bare map
// value — the pointer indirection gives the map a default (nullptr) and a
// constructed-once binding.
struct RawBinding {
  Arv::Stream::Ptr source; // keeps the camera stream alive for the pipe's life
  const std::string sourceId;    // "camera/<serial>" (topology input edge)
  const std::string sensorFormat; // raw wire format string (pipe pixelFormat)
  const std::string dtype;        // container dtype (U8/U16), topology row
  Pipe::FrameSink *const sink = nullptr;
  const uint32_t maxW = 0;
  const uint32_t maxH = 0;
  // Constructed BEFORE `subscriber` → destructed AFTER it (unsubscribe first);
  // the subscriber writes to it on the capture thread. Persists across gate
  // toggles → the probe survives park/unpark (single writer = the current sub).
  Meter::ThreadMeter meter;
  // Declared LAST → destructed FIRST (unsubscribe before meter/source release).
  std::unique_ptr<RawPipeSubscriber> subscriber; // gated lifetime

  // `name` = the pipeId (meter names ARE node ids — the topology folds stats
  // onto nodes by id, like the other bricks).
  RawBinding(const std::string &name, Arv::Stream::Ptr source,
             std::string sourceId, std::string sensorFormat, std::string dtype,
             Pipe::FrameSink *sink, uint32_t maxW, uint32_t maxH)
      : source(std::move(source)), sourceId(std::move(sourceId)),
        sensorFormat(std::move(sensorFormat)), dtype(std::move(dtype)),
        sink(sink), maxW(maxW), maxH(maxH),
        meter(name, {"frame"}, {"shm"}, converterNowMs()) {}
};

static std::mutex g_mutex;
static std::map<std::string, std::unique_ptr<RawBinding>> g_pipes;

// ---- attach: bind the camera source, gate the raw subscriber ---------------
FN(attachRawPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    JS_ASSERT(info[1].IsString(), TypeError,
              "attachRawPipe: pipeId (string) required", env.Undefined());
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error, "attachRawPipe: unknown pipe " + pipeId,
              env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    const uint32_t maxW = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxH = spec.maxHeight ? spec.maxHeight : spec.height;

    auto source = Arv::Stream::get(camera); // shared camera stream (exclusivity)
    std::string sourceId = "camera/?";
    try {
      sourceId = std::string("camera/") + camera->get_serial();
    } catch (...) {
    }
    {
      std::scoped_lock lock(g_mutex);
      // Re-attach replaces the binding wholesale (a fresh meter + source ref);
      // the old binding (with its gated subscriber) destructs here.
      g_pipes[pipeId] = std::make_unique<RawBinding>(
          pipeId, std::move(source), std::move(sourceId), spec.pixelFormat,
          spec.dtype, sink, maxW, maxH);
    }
    // Register the gate OUTSIDE the lock: it fires immediately with the current
    // consumer state (creating the subscriber if a consumer is already
    // connected), which re-locks g_mutex.
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end() || !it->second)
        return;
      auto &b = *it->second;
      if (active && !b.subscriber)
        b.subscriber = std::make_unique<RawPipeSubscriber>(
            b.source.get(), b.sink, b.maxW, b.maxH, &b.meter);
      else if (!active && b.subscriber)
        b.subscriber.reset();
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachRawPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    // Clear the gate before touching the registry so no edge fires into freed
    // state (both are NAPI-thread).
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    std::unique_ptr<RawBinding> removed; // destructed OUTSIDE the lock (join)
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end()) {
        removed = std::move(it->second);
        g_pipes.erase(it);
      }
    }
    return Boolean::New(env, removed != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- per-pipeId raw producer meter snapshots (→ perfSnapshot.workloads) -----
FN(rawProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes)
    if (b)
      out.Set(pipeId, meterSnapshotToJs(env, b->meter.probe(converterNowMs())));
  return out;
}

// ---- Topology.report() rows (unified-time-and-topology §6) ------------------
// One raw-pipe row: id, kind "raw", ACTUAL input edge camera/<serial> (raw wire
// format), output = the sensor format pipe, full meter stats; transport/epoch/
// pipe extras stamped when the id is a live advertised pipe.
void appendRawReports(Napi::Env env, Napi::Array &rows,
                      std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b)
      continue;
    auto row = Topology::node(env, pipeId, "raw", "native");
    Topology::addInput(env, row, b->sourceId, "frame",
                       Topology::frameType(env, b->sensorFormat, b->dtype));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, b->sensorFormat, b->dtype));
    row.Set("stats", meterSnapshotToJs(env, b->meter.probe(converterNowMs())));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
