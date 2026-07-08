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
  PixelFormat format = BGRA8;
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
  PixelFormat format = BGRA8;
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

// The in-process tap: a DIRECT synchronous-consume Subscriber on any
// ConvertedFrame producer (ConverterStream / UndistortStream / FoveaStream)
// that deep-copies each product into a fresh OwnedFrame and publishes it into
// a `Threading::Leaky<OwnedFrame>` (latest-wins — the ruled default transport
// for vision stages). Its EXISTENCE is the demand signal: constructing it
// subscribes (waking the producer via the Stream base's auto-park), destroying
// it unsubscribes (producer parks when no other subscriber remains). The
// channel is closeable from both ends: producer death closes it via close()
// (downstream sees EOS); downstream closing the channel ejects this publisher
// from the producer on the next push (Unsubscribe).
class TapPublisher : public Subscriber<ConvertedFrame::Ptr> {
public:
  using Channel = Threading::Leaky<OwnedFrame>;
  TapPublisher(::Stream<ConvertedFrame::Ptr> *producer, Channel::Ptr channel)
      : Subscriber<ConvertedFrame::Ptr>(producer),
        channel_(std::move(channel)) {}
  ~TapPublisher() { close(); }

  void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) override {
    Subscriber<ConvertedFrame::Ptr>::close(unsubscribe, err);
    if (channel_)
      channel_->close(); // downstream `next()` throws EOS -> orderly stop
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
      channel_->write(sp);
    } catch (Threading::EOS &) {
      throw Unsubscribe(); // downstream closed the channel — eject self
    }
  }

private:
  Channel::Ptr channel_;
  uint64_t seq_ = 0; // producer-thread only
};

// Base of the CHAINED bricks (undistort v2, fovea v2): a producer thread whose
// INPUT is another brick's OwnedFrame tap instead of the raw Arv::Stream.
// Demand propagates through the existing park machinery with no extra state:
//   - this brick runs iff it has ≥1 subscriber (SHM PipeOfferSubscriber via
//     the consumer gate, or a downstream brick's TapPublisher);
//   - start() (fired by the Stream base on the parked→active edge) opens the
//     tap on the source — subscribing wakes the source brick;
//   - stop() (active→parked) closes it — the source parks when nothing else
//     demands it. Parked ⇔ no demand, across BOTH transports.
// The source is held by shared_ptr: a chained brick keeps its upstream brick
// alive even if the upstream's NAPI binding detaches first (no dangling
// Subscriber back-pointers). If the source stream TERMINATED, this brick
// crashes (subscribers ejected) rather than spinning on a dead tap.
class ChainedStream : public ::Stream<ConvertedFrame::Ptr> {
public:
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

public:
  virtual ~ChainedStream() { assert_shutdown_called(); }

protected:
  explicit ChainedStream(Source source) : source_(std::move(source)) {}
  // Derived destructors MUST call closeChain() then shutdown(): closing the
  // channel wakes a `next(wait)`-blocked thread (EOS -> StopIteration) so the
  // join in shutdown() can never hang on a stalled upstream.
  void closeChain() {
    TapPublisher::Channel::Ptr ch;
    {
      auto ref = channel_.ref();
      ch = *ref;
    }
    if (ch)
      ch->close();
  }

  void start() override {
    auto ch = TapPublisher::Channel::create();
    {
      auto ref = channel_.ref();
      *ref = ch;
    }
    last_ = nullptr;
    pub_ = std::make_unique<TapPublisher>(source_.get(), ch);
    // A terminated source refuses the subscription (state closed immediately).
    if (!pub_->state.snapshot().isActive())
      throw std::runtime_error("chain source stream already terminated");
  }

  void stop() override {
    pub_.reset(); // unsubscribe FIRST — the source may park
    {
      auto ref = channel_.ref();
      if (*ref)
        (*ref)->close();
      *ref = nullptr;
    }
    last_ = nullptr;
  }

  ConvertedFrame::Ptr iterate() override {
    TapPublisher::Channel::Ptr ch;
    {
      auto ref = channel_.ref();
      ch = *ref;
    }
    if (!ch)
      throw StopIteration();
    try {
      if (!ch->next(last_, /*wait=*/true))
        return nullptr;
    } catch (Threading::EOS &) {
      // Channel closed: by our own teardown (destructor/stop) OR by the source
      // crashing/terminating (TapPublisher::close). Either way this activation
      // is over; the base re-enters start() if demand persists, which throws
      // (-> crash, subscribers ejected) when the source is truly gone.
      throw StopIteration();
    }
    if (!last_)
      return nullptr;
    return process(last_);
  }

  // Per-frame work, on this brick's thread, input OWNED (retainable).
  virtual ConvertedFrame::Ptr process(const OwnedFrame::Ptr &input) = 0;

  // Latest-wins drops on the tap since the last call (seq-gap accounting).
  uint64_t seqGap(const OwnedFrame::Ptr &in) {
    const uint64_t gap =
        (lastSeq_ && in->seq > lastSeq_ + 1) ? in->seq - lastSeq_ - 1 : 0;
    lastSeq_ = in->seq;
    return gap;
  }

  const Source source_; // shared: keeps the upstream brick alive

private:
  Threading::Guard<TapPublisher::Channel::Ptr> channel_{nullptr};
  std::unique_ptr<TapPublisher> pub_; // exists only while active (start..stop)
  OwnedFrame::Ptr last_;              // this thread only (Leaky cursor)
  uint64_t lastSeq_ = 0;              // this thread only (start() epoch-safe:
                                      // a fresh tap restarts seq at 1; gaps
                                      // only ever shrink to 0 across restarts)
};

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
    info.bytes = static_cast<size_t>(m.cols) * m.rows * m.channels();
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

} // namespace Arv
