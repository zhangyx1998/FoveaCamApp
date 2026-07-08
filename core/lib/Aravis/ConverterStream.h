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

#include <opencv2/opencv.hpp>

#include <Pipe.h> // C's FrameSink/FrameInfo + ShmRing::FrameMeta (call across)
#include <ThreadMeter.h>

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
      : upstream_(std::move(upstream)), target_(target),
        meter_(std::move(name), {"frame"}, {"converted"}, converterNowMs()) {}
  ~ConverterStream() override { shutdown(); }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  PixelFormat target() const { return target_; }

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
    cf->deviceTimestamp = frame->device_timestamp;
    cf->systemTimestamp = frame->system_timestamp;
    cf->convertMs = convertMs;
    meter_.emit("converted", converterNowMs());
    return cf;
  }

private:
  Arv::Stream::Ptr upstream_;
  const PixelFormat target_;
  Meter::ThreadMeter meter_; // single writer = this transform thread
  cv::Mat buf_;              // reused conversion target (transform thread only)
  uint64_t lastDrops_ = 0;  // transform-thread only
};

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
