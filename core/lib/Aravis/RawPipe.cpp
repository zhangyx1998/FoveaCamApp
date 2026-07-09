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
// `dtype` (U8/U16) follows the container width. Truly-packed preservation lives
// in the SECOND half of this file (multi-fovea-recording ruling 1): the raw12p
// pipes tap the ArvBuffer BEFORE Frame construction via `Arv::Stream::BufferTap`
// and publish the verbatim packed wire payload.

#include <algorithm>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <vector>

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

// ============================================================================
// multi-fovea-recording ruling 1: PACKED raw-12p pipes (pre-Frame ArvBuffer tap)
// ============================================================================
// The raw tap above publishes `frame->raw` — the UNPACKED full-depth container
// (packed 12p is expanded to 16-bit at Frame construction, see Frame.h). A
// multi-fovea recording instead wants the VERBATIM packed wire payload (the
// literal Bayer-12p bytes the sensor sent) so fovea imagery re-encodes offline
// without a lossy expand→repack round trip. Those bytes exist ONLY before Frame
// construction, so this tap captures them at the ArvBuffer level via
// `Arv::Stream::BufferTap` — fired inside `Stream::iterate()` BEFORE the unpack
// and BEFORE the requeue — and publishes the arv_buffer payload byte-for-byte
// into a `camera/<serial>/raw12p` pipe.
//
// FORMAT-AGNOSTIC: it copies whatever the negotiated wire format is (packed 12p
// on a 12p-readout sensor; plain Mono8/Bayer8/Mono16 otherwise) — it NEVER
// assumes packing. Payload size, dims and (implicitly) stride are read from the
// buffer, not computed. Same consumer gate as the raw tap: no consumer ⇒ the
// tap is not registered on the stream ⇒ zero capture-thread cost.

// Keeps the camera capture loop RUNNING while a packed tap is attached. Every
// `::Stream` iterates ONLY while it has ≥1 Frame::Ptr subscriber (see
// Stream/Stream.h loop()), so a buffer tap alone would never see a frame. This
// no-op subscriber holds the loop open (and parks it when the last tap detaches
// — the same on-demand contract as the raw pipe's real subscriber); its push()
// ignores the already-unpacked Frame — the tap grabbed the packed bytes
// upstream inside iterate().
class StreamKeepAlive : public Subscriber<Frame::Ptr> {
public:
  explicit StreamKeepAlive(::Stream<Frame::Ptr> *producer)
      : Subscriber<Frame::Ptr>(producer) {}

protected:
  void push(const Frame::Ptr &) override {}
};

// The in-process OwnedFrame tap fan-out (multi-fovea-recording R-1). Lives in
// the Raw12pBinding (persists across gate toggles); the gated Raw12pTap holds a
// pointer to it and, on the CAPTURE thread, publishes ONE deep-copied OwnedFrame
// to each registered channel — but ONLY when ≥1 channel is registered (the
// atomic count is the lock-free fast-path gate, so a raw12p pipe with no
// in-process consumer pays zero extra capture-thread cost). Channels are
// latest-wins (Leaky): a write NEVER blocks the capture thread; a channel that
// reports EOS (its downstream closed) is dropped.
struct Raw12pFanout {
  std::mutex mutex;
  std::vector<TapChannel::Ptr> channels;
  std::atomic<uint32_t> count{0}; // lock-free capture-thread gate

  void add(const TapChannel::Ptr &ch) {
    std::scoped_lock lk(mutex);
    channels.push_back(ch);
    count.store(channels.size(), std::memory_order_release);
  }
  void remove(const TapChannel::Ptr &ch) {
    std::scoped_lock lk(mutex);
    channels.erase(std::remove(channels.begin(), channels.end(), ch),
                   channels.end());
    count.store(channels.size(), std::memory_order_release);
  }
  bool active() const { return count.load(std::memory_order_acquire) != 0; }

  // Capture thread: fan ONE OwnedFrame out to every channel (non-blocking).
  void publish(const OwnedFrame::Ptr &of) {
    std::scoped_lock lk(mutex);
    for (auto it = channels.begin(); it != channels.end();) {
      try {
        OwnedFrame::Ptr sp = of; // Leaky::write takes an lvalue ref
        (*it)->write(sp);
        ++it;
      } catch (Threading::EOS &) {
        it = channels.erase(it); // downstream closed — drop it
      }
    }
    count.store(channels.size(), std::memory_order_release);
  }
};

// The packed producer: an `Arv::Stream::BufferTap` (not a Frame::Ptr Subscriber
// — the packed bytes are gone by the time any Frame exists). Registers itself on
// the stream's buffer-tap registry at construction and unregisters at
// destruction; `onBuffer` runs on the CAPTURE thread synchronously inside
// iterate(), copying the payload into the ring BEFORE the ArvBuffer is requeued
// (extract-before-release at buffer level). It ALSO holds a `StreamKeepAlive` so
// the capture loop actually runs on-demand.
class Raw12pTap : public Arv::Stream::BufferTap {
public:
  Raw12pTap(Arv::Stream *stream, Pipe::FrameSink *sink, uint32_t maxRowBytes,
            uint32_t maxRows, size_t maxBytes, Meter::ThreadMeter *meter,
            Raw12pFanout *fanout)
      : stream_(stream), sink_(sink), maxRowBytes_(maxRowBytes),
        maxRows_(maxRows), maxBytes_(maxBytes), meter_(meter), fanout_(fanout) {
    if (stream_) {
      stream_->addBufferTap(this);          // iterate() → onBuffer
      keepAlive_ = std::make_unique<StreamKeepAlive>(stream_); // run the loop
    }
  }
  ~Raw12pTap() {
    if (stream_)
      stream_->removeBufferTap(this); // stop onBuffer (blocks on in-flight copy)
    keepAlive_.reset();               // then park the capture loop (unsubscribe)
  }

  void onBuffer(ArvBuffer *buffer, int64_t clockOffsetNs) override {
    if (!buffer || !sink_)
      return;
    if (arv_buffer_get_status(buffer) != ARV_BUFFER_STATUS_SUCCESS) {
      if (meter_)
        meter_->drop();
      return;
    }
    size_t payloadSize = 0;
    const void *data = arv_buffer_get_data(buffer, &payloadSize);
    if (!data || payloadSize == 0) {
      if (meter_)
        meter_->drop();
      return;
    }
    const int64_t t = converterNowMs();
    // Represent the verbatim payload as tight rows for the ring's row-by-row
    // copy. Preserve the image row count when the payload divides evenly (the
    // common case — every whole-byte format, and packed 12p on even widths);
    // otherwise fall back to ONE contiguous blob (`rows==1`). Either way the
    // copy is `rowBytes*rows == payloadSize` bytes, verbatim — the tap makes no
    // assumption about the wire packing layout.
    const uint32_t imgH = arv_buffer_get_image_height(buffer);
    const uint32_t rows = (imgH > 0 && (payloadSize % imgH) == 0) ? imgH : 1u;
    const uint32_t rowBytes = static_cast<uint32_t>(payloadSize / rows);
    // Fixed-footprint guard: the packed payload must fit the advertised max
    // (advertise in the PACKED representation — maxWidth ≥ rowBytes, maxHeight ≥
    // rows, maxBytes ≥ payloadSize); a wire-format/resolution change ⇒
    // re-advertise. offer() re-checks identically and would drop anyway.
    if (rowBytes == 0 || rowBytes > maxRowBytes_ || rows > maxRows_ ||
        payloadSize > maxBytes_) {
      if (meter_)
        meter_->drop();
      return;
    }
    if (meter_) {
      meter_->ingest("frame", t);
      meter_->begin(t);
    }
    Pipe::FrameInfo info;
    info.width = rowBytes;
    info.height = rows;
    info.channels = 1;
    info.bytesPerElement = 1;   // a raw byte stream (the packing is opaque)
    info.stride = rowBytes;     // tight — the payload is already contiguous
    info.bytes = payloadSize;
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(t);
    // Owner-applied calibrated device time — computed EXACTLY as Frame's ctor
    // (raw device counter + the SAME clock offset iterate() passed to
    // Frame::create), so raw12p and raw stamp identical times for one frame
    // (trusted-time: applied once at the source, never restamped downstream).
    meta.deviceTimestamp = static_cast<uint64_t>(
        static_cast<int64_t>(arv_buffer_get_timestamp(buffer)) + clockOffsetNs);
    meta.systemTimestamp = arv_buffer_get_system_timestamp(buffer);
    sink_->offer(data, info, meta); // synchronous copy into the ring, pre-requeue
    // In-process OwnedFrame tap (R-1): deep-copy the SAME verbatim payload into
    // an OwnedFrame (U8 Mat header, rows×rowBytes) and fan it out — but only if
    // a brick consumer registered a channel (lock-free `active()` gate). The
    // packed payload rides a U8 Mat; dims/origin(0,0)/timestamps/seq carried.
    if (fanout_ && fanout_->active()) {
      auto of = OwnedFrame::create();
      cv::Mat header(static_cast<int>(rows), static_cast<int>(rowBytes),
                     CV_8UC1, const_cast<void *>(data));
      header.copyTo(of->mat); // DEEP copy — ownership transfer off the ArvBuffer
      of->deviceTimestamp = meta.deviceTimestamp;
      of->systemTimestamp = meta.systemTimestamp;
      of->originX = 0;
      of->originY = 0;
      of->seq = ++tapSeq_;
      fanout_->publish(of);
    }
    if (meter_) {
      const int64_t done = converterNowMs(); // one clock read, not two
      meter_->end(done);
      meter_->emit("shm", done);
    }
  }

private:
  Arv::Stream *const stream_; // the tap registry we (un)register on
  Pipe::FrameSink *const sink_;
  const uint32_t maxRowBytes_, maxRows_;
  const size_t maxBytes_;
  Meter::ThreadMeter *const meter_; // owned by the binding; single writer here
  Raw12pFanout *const fanout_;      // owned by the binding; capture-thread fanout
  uint64_t tapSeq_ = 0;             // capture-thread-only OwnedFrame sequence
  std::unique_ptr<StreamKeepAlive> keepAlive_; // holds the capture loop open
};

struct Raw12pBinding {
  Arv::Stream::Ptr source;        // keeps the camera stream alive for the pipe
  const std::string sourceId;     // "camera/<serial>" (topology input edge)
  const std::string sensorFormat; // wire format string (pipe pixelFormat)
  const std::string dtype;        // container dtype (U8 — a packed byte stream)
  Pipe::FrameSink *const sink = nullptr;
  const uint32_t maxRowBytes = 0; // packed representation (see the tap guard)
  const uint32_t maxRows = 0;
  const size_t maxBytes = 0;
  Meter::ThreadMeter meter;               // persists across gate toggles
  Raw12pFanout fanout;            // in-process tap fan-out (persists; tap → dtor
                                  // FIRST so it stops touching this)
  std::unique_ptr<Raw12pTap> tap; // gated lifetime (declared LAST → dtor FIRST)

  Raw12pBinding(const std::string &name, Arv::Stream::Ptr source,
                std::string sourceId, std::string sensorFormat,
                std::string dtype, Pipe::FrameSink *sink, uint32_t maxRowBytes,
                uint32_t maxRows, size_t maxBytes)
      : source(std::move(source)), sourceId(std::move(sourceId)),
        sensorFormat(std::move(sensorFormat)), dtype(std::move(dtype)),
        sink(sink), maxRowBytes(maxRowBytes), maxRows(maxRows),
        maxBytes(maxBytes),
        meter(name, {"frame"}, {"shm"}, converterNowMs()) {}
};

static std::mutex g_mutex12;
static std::map<std::string, std::unique_ptr<Raw12pBinding>> g_pipes12;

// ---- attach: bind the camera source, gate the packed tap -------------------
FN(attachRaw12pPipe) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    JS_ASSERT(info[1].IsString(), TypeError,
              "attachRaw12pPipe: pipeId (string) required", env.Undefined());
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachRaw12pPipe: unknown pipe " + pipeId, env.Undefined());
    const auto &spec = hub.publisher(pipeId).spec();
    // Advertise in the PACKED representation (maxWidth = max packed row bytes,
    // maxHeight = row count, maxBytes = max payload). Fall back to nominal.
    const uint32_t maxRowBytes = spec.maxWidth ? spec.maxWidth : spec.width;
    const uint32_t maxRows = spec.maxHeight ? spec.maxHeight : spec.height;
    const size_t maxBytes =
        spec.maxBytes ? static_cast<size_t>(spec.maxBytes)
                      : static_cast<size_t>(spec.bytesPerFrame);

    auto source = Arv::Stream::get(camera); // shared camera stream (exclusivity)
    std::string sourceId = "camera/?";
    try {
      sourceId = std::string("camera/") + camera->get_serial();
    } catch (...) {
    }
    {
      std::scoped_lock lock(g_mutex12);
      g_pipes12[pipeId] = std::make_unique<Raw12pBinding>(
          pipeId, std::move(source), std::move(sourceId), spec.pixelFormat,
          spec.dtype, sink, maxRowBytes, maxRows, maxBytes);
    }
    // Register the gate OUTSIDE the lock: it fires immediately with the current
    // consumer state (creating the tap if a consumer is already connected),
    // which re-locks g_mutex12.
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex12);
      auto it = g_pipes12.find(pipeId);
      if (it == g_pipes12.end() || !it->second)
        return;
      auto &b = *it->second;
      if (active && !b.tap)
        b.tap = std::make_unique<Raw12pTap>(b.source.get(), b.sink,
                                            b.maxRowBytes, b.maxRows, b.maxBytes,
                                            &b.meter, &b.fanout);
      else if (!active && b.tap)
        b.tap.reset(); // unregisters the tap from the stream
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachRaw12pPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    std::unique_ptr<Raw12pBinding> removed; // destructed OUTSIDE the lock
    {
      std::scoped_lock lock(g_mutex12);
      auto it = g_pipes12.find(pipeId);
      if (it != g_pipes12.end()) {
        removed = std::move(it->second);
        g_pipes12.erase(it);
      }
    }
    return Boolean::New(env, removed != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- in-process OwnedFrame tap open/close (R-1; brick→brick transport) ------
// Register/unregister an OwnedFrame channel on the raw12p pipe's fan-out. The
// CALLER (CompressStream) must ALSO drive the pipe's consumer gate (a
// connect()) so the gated Raw12pTap exists and produces. Channel MUST be Leaky
// (capture-thread fan-out never blocks). Both hold g_mutex12 only briefly.
bool openRaw12pTap(const std::string &pipeId, const TapChannel::Ptr &channel) {
  if (!channel)
    return false;
  std::scoped_lock lock(g_mutex12);
  auto it = g_pipes12.find(pipeId);
  if (it == g_pipes12.end() || !it->second)
    return false;
  it->second->fanout.add(channel);
  return true;
}

void closeRaw12pTap(const std::string &pipeId, const TapChannel::Ptr &channel) {
  {
    std::scoped_lock lock(g_mutex12);
    auto it = g_pipes12.find(pipeId);
    if (it != g_pipes12.end() && it->second)
      it->second->fanout.remove(channel);
  }
  if (channel)
    channel->close(); // wake a consumer blocked in poll(wait) (EOS -> stop)
}

// ---- per-pipeId packed producer meter snapshots -----------------------------
FN(raw12pProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex12);
  for (const auto &[pipeId, b] : g_pipes12)
    if (b)
      out.Set(pipeId, meterSnapshotToJs(env, b->meter.probe(converterNowMs())));
  return out;
}

// ---- Topology.report() rows: one row per packed pipe, kind "raw12p" ---------
void appendRaw12pReports(Napi::Env env, Napi::Array &rows,
                         std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex12);
  for (const auto &[pipeId, b] : g_pipes12) {
    if (!b)
      continue;
    auto row = Topology::node(env, pipeId, "raw12p", "native");
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
