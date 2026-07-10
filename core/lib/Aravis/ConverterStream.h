// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// WS1 real-1e (B-18): the per-stream format converter thread. Replaces the
// inline-convert `CaptureSink`. A dedicated thread per (camera × target format)
// runs the SHARED `convertFrame` (raw→display, incl. the >8-bit down-scale) OFF
// the capture thread; a thin B-owned `Subscriber` offers the converted bytes to
// C's pipe `FrameSink`. Both auto-park when the pipe's consumers drain (the
// `Stream` base parks on empty subscribers — no lifecycle code).

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>

#include <opencv2/opencv.hpp>

#include <Pipe.h> // C's FrameSink/FrameInfo + ShmRing::FrameMeta (call across)
#include <ThreadMeter.h>
#include <Threading/FIFO.h>
#include <Threading/Leaky.h>
#include <Threading/exception.h>

#include <Iterator.h> // TransformStream, Subscriber

#include "Frame.h"  // Arv::Frame, convertFrame, PixelFormat
#include "Stream.h" // Arv::Stream

namespace Arv {

inline int64_t converterNowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}

// Post-convert product of a ConverterStream. `mat` IS the ConverterStream's
// REUSED buffer (a header over it), valid ONLY during the synchronous dispatch
// to subscribers — exactly the existing onView view-tap contract ("the Mat is
// the reused buffer; copy out to retain"). The single pipe subscriber's
// `offer()` copies it into the ring inline, before the next frame overwrites
// the buffer. Any future BUFFERING consumer of a ConverterStream must copy.
struct ConvertedFrame : Shared<ConvertedFrame> {
  cv::Mat mat;
  // Pixel format of `mat` (the producing brick's target/passthrough format) —
  // stamped so in-process taps (unified-time-and-topology §5) can carry the
  // frame's typing without consulting the producer.
  PixelFormat format = RGBA8;
  uint64_t deviceTimestamp = 0;
  uint64_t systemTimestamp = 0;
  double convertMs = 0;
  // B-24 fovea crops: the crop origin in SOURCE coordinates, FRAME-BOUND to
  // this product (a JS rect echo races). 0/0 for full-frame producers. Flows
  // through FrameInfo into the v4 slot header (C-24 substrate) — the reader
  // surfaces it per-frame alongside the C-20 active w/h.
  uint32_t originX = 0;
  uint32_t originY = 0;
};

// unified-time-and-topology §5 (B, native re-plumb): the OWNED element type of
// the in-process brick→brick Leaky tap. Unlike `ConvertedFrame` (a header over
// the producer's REUSED buffer, valid only during synchronous dispatch), an
// OwnedFrame's `mat` OWNS its heap buffer — the tap publisher deep-copies at
// publish time, so ownership transfer (shared_ptr) retires the reuse-contract
// hazard: a downstream brick may retain/consume it on its own thread at its
// own pace. Allocated ONLY while ≥1 downstream tap is subscribed (zero cost
// otherwise — no TapPublisher, no copy).
struct OwnedFrame : Shared<OwnedFrame> {
  cv::Mat mat; // OWNS its data (deep copy); width/height/stride/type live here
  PixelFormat format = RGBA8;
  uint64_t deviceTimestamp = 0;
  uint64_t systemTimestamp = 0;
  // Monotonic per-tap sequence — downstream meters latest-wins drops from the
  // gaps (`seq - lastSeq - 1` frames were overwritten unconsumed).
  uint64_t seq = 0;
  // Frame-bound crop origin (fovea semantics), forwarded from ConvertedFrame.
  uint32_t originX = 0;
  uint32_t originY = 0;
  // Upstream processing ms for this frame (convert / convert+remap so far).
  double upstreamMs = 0;

  uint32_t width() const { return static_cast<uint32_t>(mat.cols); }
  uint32_t height() const { return static_cast<uint32_t>(mat.rows); }
  uint32_t stride() const { return static_cast<uint32_t>(mat.step); }
};

// The transport of the brick→brick OwnedFrame handoff. Two implementations
// (selected per-chain via `ChannelKind`), presenting ONE producer/consumer
// surface so `TapPublisher` and `ChainedStreamOf` are transport-agnostic:
//   - LeakyTapChannel (default): latest-wins — a slow consumer sheds stale
//     frames; the ruled transport for previews, fovea crops and trackers
//     (track the freshest). Skips are metered downstream via `OwnedFrame.seq`.
//   - FifoTapChannel{capacity}: bounded blocking queue — EVERY frame in order,
//     and a full queue BLOCKS the producer's synchronous dispatch. That
//     backpressure is the DESIGN for the undistort input (controller-node-and-
//     fifo-edges §1): the source's own camera input is latest-wins, so
//     sustained overload sheds at the camera→convert edge (metered as
//     converter drops) while convert→undistort stays complete and ordered.
//     Metered: exposes depth / windowed high-water / capacity for the
//     consumer brick's ThreadMeter.
// Both close from either end (producer death or downstream close); a full FIFO
// close wakes the blocked producer (EOS -> Unsubscribe) — FIFO.h notifies
// cond_r on close, and its push wait-loop rechecks `closed`.
class TapChannel {
public:
  using Ptr = std::shared_ptr<TapChannel>;
  virtual ~TapChannel() = default;
  // Producer side (source-brick dispatch thread). Throws Threading::EOS once
  // the channel is closed. A FIFO channel BLOCKS here while full (backpressure).
  virtual void write(OwnedFrame::Ptr &frame) = 0;
  // Consumer side (chained-brick thread). Blocks for the next frame (wait);
  // sets `out` and returns true on a frame, false on a spurious wake with no
  // new frame (Leaky only — caller yields). Throws Threading::EOS on close.
  virtual bool poll(OwnedFrame::Ptr &out, bool wait) = 0;
  virtual void close() = 0;
  // Queue metering — FIFO only (`metered()` is false for Leaky). `takeHighWater`
  // returns the peak occupancy since the previous call (windowed-max feed) and
  // resets the tracker; consumer-thread only.
  virtual bool metered() const { return false; }
  virtual uint32_t takeHighWater() { return 0; }
  virtual uint32_t capacity() const { return 0; }
};

class LeakyTapChannel : public TapChannel {
public:
  void write(OwnedFrame::Ptr &frame) override { leaky_.write(frame); }
  bool poll(OwnedFrame::Ptr &out, bool wait) override {
    if (!leaky_.next(cursor_, wait)) // latest-wins: only a NEW ptr counts
      return false;
    out = cursor_;
    return out != nullptr;
  }
  void close() override { leaky_.close(); }

private:
  Threading::Leaky<OwnedFrame> leaky_;
  OwnedFrame::Ptr cursor_; // consumer-thread latest-wins cursor
};

class FifoTapChannel : public TapChannel {
public:
  explicit FifoTapChannel(size_t capacity)
      : fifo_(capacity), capacity_(capacity) {}
  void write(OwnedFrame::Ptr &frame) override {
    fifo_.write(frame); // BLOCKS while full (backpressure); throws EOS on close
  }
  bool poll(OwnedFrame::Ptr &out, bool /*wait*/) override {
    out = fifo_.read(); // blocks until a frame or EOS (never nullptr in-band)
    return out != nullptr;
  }
  void close() override { fifo_.close(); }
  bool metered() const override { return true; }
  uint32_t takeHighWater() override {
    return static_cast<uint32_t>(fifo_.take_high_water());
  }
  uint32_t capacity() const override {
    return static_cast<uint32_t>(capacity_);
  }

private:
  Threading::FIFO<OwnedFrame::Ptr> fifo_;
  const size_t capacity_;
};

// Per-chain transport selector: Leaky (default) or a bounded Fifo.
struct ChannelKind {
  enum Type { Leaky, Fifo } type = Leaky;
  size_t capacity = 0; // Fifo only
  static ChannelKind leaky() { return {}; }
  static ChannelKind fifo(size_t cap) { return {Fifo, cap}; }
  TapChannel::Ptr make() const {
    if (type == Fifo)
      return std::static_pointer_cast<TapChannel>(
          std::make_shared<FifoTapChannel>(capacity));
    return std::static_pointer_cast<TapChannel>(
        std::make_shared<LeakyTapChannel>());
  }
};

// The in-process tap: a DIRECT synchronous-consume Subscriber on any
// ConvertedFrame producer (ConverterStream / UndistortStream / FoveaStream)
// that deep-copies each product into a fresh OwnedFrame and publishes it into
// a `TapChannel` (Leaky or Fifo — the chain picks). Its EXISTENCE is the demand
// signal: constructing it subscribes (waking the producer via the Stream base's
// auto-park), destroying it unsubscribes (producer parks when no other
// subscriber remains). The channel is closeable from both ends: producer death
// closes it via close() (downstream sees EOS); downstream closing the channel
// ejects this publisher from the producer on the next push/blocked-push
// (Unsubscribe).
class TapPublisher : public Subscriber<ConvertedFrame::Ptr> {
public:
  TapPublisher(::Stream<ConvertedFrame::Ptr> *producer, TapChannel::Ptr channel)
      : Subscriber<ConvertedFrame::Ptr>(producer),
        channel_(std::move(channel)) {}
  ~TapPublisher() { close(); }

  void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) override {
    Subscriber<ConvertedFrame::Ptr>::close(unsubscribe, err);
    if (channel_)
      channel_->close(); // downstream `poll()` throws EOS -> orderly stop
  }

protected:
  void push(const ConvertedFrame::Ptr &cf) override {
    if (!cf || !channel_)
      return;
    auto of = OwnedFrame::create();
    cf->mat.copyTo(of->mat); // DEEP copy — the ownership transfer
    of->format = cf->format;
    of->deviceTimestamp = cf->deviceTimestamp;
    of->systemTimestamp = cf->systemTimestamp;
    of->originX = cf->originX;
    of->originY = cf->originY;
    of->upstreamMs = cf->convertMs;
    of->seq = ++seq_;
    try {
      OwnedFrame::Ptr sp = std::move(of);
      channel_->write(sp); // FIFO: may block here (backpressure) until drained
    } catch (Threading::EOS &) {
      throw Unsubscribe(); // downstream closed the channel — eject self
    }
  }

private:
  TapChannel::Ptr channel_;
  uint64_t seq_ = 0; // producer-thread only
};

// Base of the CHAINED bricks (undistort v2, fovea v2, chained KCF tracker): a
// producer thread whose INPUT is another brick's OwnedFrame tap instead of the
// raw Arv::Stream. Templated on the OUTPUT payload (ConvertedFrame for the
// vision bricks, TrackResult for the chained tracker) — the input tap type is
// always OwnedFrame. Demand propagates through the existing park machinery with
// no extra state:
//   - this brick runs iff it has ≥1 subscriber (SHM PipeOfferSubscriber via
//     the consumer gate, a downstream brick's TapPublisher, or a JS Sub::Queue);
//   - start() (fired by the Stream base on the parked→active edge) opens the
//     tap on the source — subscribing wakes the source brick;
//   - stop() (active→parked) closes it — the source parks when nothing else
//     demands it. Parked ⇔ no demand, across BOTH transports.
// The source is held by shared_ptr: a chained brick keeps its upstream brick
// alive even if the upstream's NAPI binding detaches first (no dangling
// Subscriber back-pointers). If the source stream TERMINATED, this brick
// crashes (subscribers ejected) rather than spinning on a dead tap.
template <SmartPtrLike Out> class ChainedStreamOf : public ::Stream<Out> {
public:
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

public:
  virtual ~ChainedStreamOf() { this->assert_shutdown_called(); }

protected:
  explicit ChainedStreamOf(Source source, ChannelKind kind = {})
      : source_(std::move(source)), kind_(kind) {}
  // Derived destructors MUST call closeChain() then shutdown(): closing the
  // channel wakes a `poll(wait)`-blocked thread (EOS -> StopIteration) so the
  // join in shutdown() can never hang on a stalled upstream.
  void closeChain() {
    TapChannel::Ptr ch;
    {
      auto ref = channel_.ref();
      ch = *ref;
    }
    if (ch)
      ch->close();
  }

  void start() override {
    auto ch = kind_.make();
    {
      auto ref = channel_.ref();
      *ref = ch;
    }
    pub_ = std::make_unique<TapPublisher>(source_.get(), ch);
    // A terminated source refuses the subscription (state closed immediately).
    if (!pub_->state.snapshot().isActive())
      throw std::runtime_error("chain source stream already terminated");
  }

  void stop() override {
    // Close the channel FIRST: a FIFO channel may have the source blocked in a
    // full-queue push (backpressure) while holding the source's dispatch mutex.
    // Closing wakes it (EOS -> Unsubscribe) so the source releases that mutex
    // before we unsubscribe (which also needs it) — otherwise deadlock.
    // Harmless for Leaky (its write never blocks).
    {
      auto ref = channel_.ref();
      if (*ref)
        (*ref)->close();
    }
    pub_.reset(); // unsubscribe — the source parks if we were its last demand
    {
      auto ref = channel_.ref();
      *ref = nullptr;
    }
  }

  Out iterate() override {
    TapChannel::Ptr ch;
    {
      auto ref = channel_.ref();
      ch = *ref;
    }
    if (!ch)
      throw StopIteration();
    OwnedFrame::Ptr in;
    try {
      if (!ch->poll(in, /*wait=*/true))
        return nullptr;
    } catch (Threading::EOS &) {
      // Channel closed: by our own teardown (destructor/stop) OR by the source
      // crashing/terminating (TapPublisher::close). Either way this activation
      // is over; the base re-enters start() if demand persists, which throws
      // (-> crash, subscribers ejected) when the source is truly gone.
      throw StopIteration();
    }
    if (!in)
      return nullptr;
    // FIFO input metering: sample the peak occupancy observed since the last
    // read (Leaky channels report unmetered — hook is a no-op there).
    if (ch->metered())
      onQueueSample(ch->takeHighWater(), ch->capacity());
    return process(in);
  }

  // Per-frame work, on this brick's thread, input OWNED (retainable).
  virtual Out process(const OwnedFrame::Ptr &input) = 0;
  // Called (FIFO chains only) right after a frame is dequeued, before process:
  // `highWater` = peak occupancy since the last read, `capacity` = FIFO bound.
  // Bricks record it into their ThreadMeter (single-writer rule preserved).
  virtual void onQueueSample(uint32_t /*highWater*/, uint32_t /*capacity*/) {}

  // Latest-wins drops on the tap since the last call (seq-gap accounting). On a
  // FIFO chain this is structurally 0; a nonzero value is a bug telltale.
  uint64_t seqGap(const OwnedFrame::Ptr &in) {
    const uint64_t gap =
        (lastSeq_ && in->seq > lastSeq_ + 1) ? in->seq - lastSeq_ - 1 : 0;
    lastSeq_ = in->seq;
    return gap;
  }

  const Source source_; // shared: keeps the upstream brick alive

private:
  ChannelKind kind_;
  Threading::Guard<TapChannel::Ptr> channel_{nullptr};
  std::unique_ptr<TapPublisher> pub_; // exists only while active (start..stop)
  uint64_t lastSeq_ = 0;              // this thread only (start() epoch-safe:
                                      // a fresh tap restarts seq at 1; gaps
                                      // only ever shrink to 0 across restarts)
};

// The vision-brick chained base (undistort v2, fovea v2): produces
// ConvertedFrames. The chained KCF tracker instantiates ChainedStreamOf with
// TrackResult directly.
using ChainedStream = ChainedStreamOf<ConvertedFrame::Ptr>;

// A converter thread bound to one camera stream + one target PixelFormat (the
// target IS the selector). TransformStream: its base thread pulls the LATEST
// camera frame (Sub::Latest, latest-wins/drop-stale) and converts into a reused
// buffer, off the capture thread. Instrumented + auto-parking.
class ConverterStream
    : public TransformStream<Frame::Ptr, ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<ConverterStream>;
  // `name` = the pipe/node id (B-24: meter names ARE node ids, so the topology
  // snapshot folds stats onto nodes by id with no shim).
  static Ptr create(Arv::Stream::Ptr upstream, PixelFormat target,
                    std::string name) {
    return std::make_shared<ConverterStream>(std::move(upstream), target,
                                             std::move(name));
  }
  ConverterStream(Arv::Stream::Ptr upstream, PixelFormat target,
                  std::string name)
      : upstream_(std::move(upstream)), target_(target), name_(name),
        meter_(std::move(name), {"frame"}, {"converted"}, converterNowMs()) {
    // Topology facts, captured at attach (NAPI thread): the physical input
    // edge (camera node id, graph-contract spelling) + its raw wire format.
    try {
      sourceId_ = std::string("camera/") + upstream_->camera->get_serial();
    } catch (...) {
      sourceId_ = "camera/?";
    }
    try {
      sourceFormat_ = convert<std::string>(
          convert<PixelFormat>(upstream_->camera->get_pixel_format()));
    } catch (...) {
      sourceFormat_ = "unknown";
    }
  }
  ~ConverterStream() override { shutdown(); }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  PixelFormat target() const { return target_; }
  const std::string &name() const { return name_; }
  // Topology.report(): the ACTUAL input edge (camera/<serial>) + raw format.
  const std::string &sourceId() const { return sourceId_; }
  const std::string &sourceFormat() const { return sourceFormat_; }

protected:
  Stream<Frame::Ptr> *upstream() override { return upstream_.get(); }

  ConvertedFrame::Ptr transform(const Frame::Ptr &frame) override {
    const int64_t t = converterNowMs();
    const uint64_t d = upstreamDrops();
    if (d > lastDrops_) { // camera outran the converter (latest-wins overwrote)
      meter_.drop(d - lastDrops_);
      lastDrops_ = d;
    }
    meter_.ingest("frame", t);

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    convertFrame(frame->raw, frame->format, target_, buf_);
    const double convertMs =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - c0)
            .count();
    meter_.end(converterNowMs());

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (see ConvertedFrame doc)
    cf->format = target_;
    cf->deviceTimestamp = frame->device_timestamp;
    cf->systemTimestamp = frame->system_timestamp;
    cf->convertMs = convertMs;
    meter_.emit("converted", converterNowMs());
    return cf;
  }

private:
  Arv::Stream::Ptr upstream_;
  const PixelFormat target_;
  std::string name_;
  std::string sourceId_;     // "camera/<serial>" (topology input edge)
  std::string sourceFormat_; // raw wire format at attach time
  Meter::ThreadMeter meter_; // single writer = this transform thread
  cv::Mat buf_;              // reused conversion target (transform thread only)
  uint64_t lastDrops_ = 0;  // transform-thread only
};

// Cross-brick lookup (UndistortStream/FoveaStream attach by convert pipeId):
// the live converter bound to `pipeId`, or nullptr. Defined in
// ConverterStream.cpp (owns the registry); NAPI-thread only.
ConverterStream::Ptr findConverter(const std::string &pipeId);

// The container dtype tag of a pixel format (graph-contract `Dtype`): >8
// significant bits live in a 16-bit container.
inline const char *dtypeOf(PixelFormat f) {
  return significantBits(f) > 8 ? "U16" : "U8";
}

// One convert-brick NodeReport row (Topology.report). Shared with the
// undistort/fovea appenders, which report their PRIVATE (legacy camera-arg)
// converters through the same shape. Defined in ConverterStream.cpp.
void appendConvertNodeRow(Napi::Env env, Napi::Array &rows,
                          const std::string &id,
                          const std::shared_ptr<ConverterStream> &c);

// The B-owned pipe producer: a DIRECT synchronous-consume Subscriber on any
// ConvertedFrame producer (ConverterStream, real-1g UndistortStream). `push`
// runs on the producer thread, in the base loop's synchronous dispatch BEFORE
// the next transform — so `offer()` (which copies into the ring) consumes the
// reused buffer safely. MUST NOT be a Sub::Latest/Queue (those retain the Ptr
// past the buffer's validity).
class PipeOfferSubscriber : public Subscriber<ConvertedFrame::Ptr> {
public:
  // `maxBound=false`: fixed-geometry pipes (converter/undistort) — a frame must
  // match the advertised w/h EXACTLY. `maxBound=true` (B-24 fovea): w/h are the
  // ring's MAX footprint — any active frame ≤ max is offered, its per-frame
  // w/h riding the C-20 slot header (Publisher::offer re-validates ≤ max).
  PipeOfferSubscriber(::Stream<ConvertedFrame::Ptr> *producer,
                      Pipe::FrameSink *sink, uint32_t width, uint32_t height,
                      bool maxBound = false)
      : Subscriber<ConvertedFrame::Ptr>(producer), sink_(sink), width_(width),
        height_(height), maxBound_(maxBound) {}
  ~PipeOfferSubscriber() { close(); } // unsubscribe before converter releases

protected:
  void push(const ConvertedFrame::Ptr &cf) override {
    if (!cf || !sink_)
      return;
    const cv::Mat &m = cf->mat;
    // Geometry guard: exact-match for fixed pipes (a size/format change ⇒ A
    // re-advertises); within-max for dynamic fovea pipes (C-20 active w/h).
    const auto w = static_cast<uint32_t>(m.cols);
    const auto h = static_cast<uint32_t>(m.rows);
    if (maxBound_ ? (w > width_ || h > height_ || w == 0 || h == 0)
                  : (w != width_ || h != height_))
      return;
    Pipe::FrameInfo info;
    info.width = static_cast<uint32_t>(m.cols);
    info.height = static_cast<uint32_t>(m.rows);
    info.channels = static_cast<uint32_t>(m.channels());
    info.stride = static_cast<uint32_t>(m.step);
    // Bytes per channel element: 1 for U8 (every existing pipe), 4 for a
    // CV_32FC1 disparity map (stereo brick) — the publisher's row/active-byte
    // math multiplies by it so a non-U8 mat is not truncated to 1 byte/elem.
    info.bytesPerElement = static_cast<uint32_t>(m.elemSize1());
    info.bytes =
        static_cast<size_t>(m.cols) * m.rows * m.channels() * m.elemSize1();
    // v4 (B-24/C-24): FRAME-BOUND crop origin rides the slot header with the
    // active size (fovea producers set it; full-frame producers leave 0/0).
    info.originX = cf->originX;
    info.originY = cf->originY;
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(converterNowMs());
    meta.convertMs = cf->convertMs;
    meta.deviceTimestamp = cf->deviceTimestamp;
    meta.systemTimestamp = cf->systemTimestamp;
    sink_->offer(m.data, info, meta); // synchronous copy into the ring
  }

private:
  Pipe::FrameSink *const sink_;
  const uint32_t width_;
  const uint32_t height_;
  const bool maxBound_;
};

// Meter::Snapshot → JS object (defined in ConverterStream.cpp; shared by
// converterProbeAll + the real-1g undistortProbeAll).
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);

// ---- raw12p in-process OwnedFrame tap (multi-fovea-recording R-1 transport) --
// The packed raw12p producer (RawPipe.cpp) exposes its VERBATIM wire payload as
// an in-process OwnedFrame tap so brick→brick consumers (CompressStream) read it
// WITHOUT a SHM ring (rings = IPC/JS-worker boundaries ONLY, ruled 2026-07-09).
// The tap fans out on the CAPTURE thread, so the channel MUST be latest-wins
// (LeakyTapChannel) — a blocking FIFO would stall capture. Drops are metered
// downstream via OwnedFrame.seq gaps. The raw12p RING output is unchanged (it
// stays the lossless path for DIRECT/uncompressed recording). Defined in
// RawPipe.cpp (owns the raw12p registry).
//   openRaw12pTap  — register `channel` in the pipe's fanout; false if unknown.
//                    The caller must ALSO drive the pipe's consumer gate (a
//                    connect()) so the gated tap actually exists + produces.
//   closeRaw12pTap — unregister + close `channel` (wakes a blocked poll); idem.
bool openRaw12pTap(const std::string &pipeId, const TapChannel::Ptr &channel);
void closeRaw12pTap(const std::string &pipeId, const TapChannel::Ptr &channel);

} // namespace Arv
