// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// stereo-disparity-and-heatmap-nodes §"StereoStream (pinned)": the FIRST
// two-input chained brick. Both inputs are OwnedFrame taps (Leaky/latest-wins)
// on any frame brick (undistort / convert / fovea / scale — same source
// resolution as ScaleStream). Unlike the single-source ChainedStreamOf, this
// brick opens TWO TapPublishers in start() (closed in stop()) so demand
// propagates to BOTH sources; either source terminating ends the brick.
//
// Pairing: tick on every LEFT arrival, matched with the LATEST RIGHT frame
// (latest-wins; no seq comparison across cameras — different owner clocks pace
// them). iterate() BLOCKS on the left channel, then drains the right channel
// non-blocking keeping only the newest, retaining the last-seen right frame
// across ticks. No right frame yet → skip. Output timestamps/origin = the LEFT
// frame's (trusted-time: forwarded, never re-stamped). Active out dims = left.
//
// Compute: BGRA→GRAY both sides, cv::StereoSGBM (MODE_SGBM) compute → CV_16S
// fixed-point → convertTo(CV_32F, 1/16) full-res float disparity. Input dims
// must match (unequal → drop + meter_.drop, the transient during steer/retune).
// Reactive params (validated NAPI-side, applied on the brick thread): the SGBM
// matcher is rebuilt when a pending param lands.

#include <atomic>
#include <cmath>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>

#include "ConverterStream.h" // TapPublisher, TapChannel, ChannelKind, ...

namespace Arv {

// The reactive SGBM spec — validated on the NAPI thread (see StereoStream.cpp),
// applied on the brick thread (rebuilds the matcher). numDisparities rounded up
// to a multiple of 16 (min 16); blockSize forced odd (min 1); minDisparity any.
struct StereoParams {
  int numDisparities = 128;
  int blockSize = 5;
  int minDisparity = 0;
};

// A two-source variant modelled on ChainedStreamOf, but NOT templated into the
// single-source base: it owns two TapChannels + two TapPublishers. Output is a
// ConvertedFrame carrying a CV_32FC1 disparity mat.
class StereoStream : public ::Stream<ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<StereoStream>;
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

  static Ptr create(Source left, std::string leftId, Source right,
                    std::string rightId, std::string name,
                    const StereoParams &params, uint32_t maxW, uint32_t maxH) {
    return std::make_shared<StereoStream>(
        std::move(left), std::move(leftId), std::move(right),
        std::move(rightId), std::move(name), params, maxW, maxH);
  }
  StereoStream(Source left, std::string leftId, Source right,
               std::string rightId, std::string name,
               const StereoParams &params, uint32_t maxW, uint32_t maxH)
      : left_(std::move(left)), right_(std::move(right)), name_(name),
        leftId_(std::move(leftId)), rightId_(std::move(rightId)), maxW_(maxW),
        maxH_(maxH), params_(params),
        meter_(std::move(name), {"left", "right"}, {"disparity"},
               converterNowMs()) {}
  // NB: ::Stream<T>'s destructor is non-virtual, but this brick is only ever
  // held by shared_ptr (its type-erased deleter destructs the concrete type).
  ~StereoStream() {
    closeChains(); // wake a blocked left poll (ChainedStream contract, both ends)
    shutdown();
  }

  // Live retune (reactive params): applied on the NEXT frame (matcher rebuild).
  void setParams(const StereoParams &p) {
    *pending_.ref() = p;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The active OUT size + forwarded origin of the LAST produced disparity map
  // (mirrors ScaleStream::activeRect — {originX, originY, w, h}).
  cv::Rect activeRect() const {
    return unpack(activePacked_.load(std::memory_order_acquire));
  }
  const std::string &name() const { return name_; }
  const std::string &leftId() const { return leftId_; }
  const std::string &rightId() const { return rightId_; }

protected:
  void start() override {
    auto lch = kind_.make();
    auto rch = kind_.make();
    { *leftCh_.ref() = lch; }
    { *rightCh_.ref() = rch; }
    leftPub_ = std::make_unique<TapPublisher>(left_.get(), lch);
    rightPub_ = std::make_unique<TapPublisher>(right_.get(), rch);
    // A terminated source refuses the subscription (state closed immediately).
    if (!leftPub_->state.snapshot().isActive() ||
        !rightPub_->state.snapshot().isActive())
      throw std::runtime_error("stereo chain source stream already terminated");
  }

  void stop() override {
    // Close BOTH channels FIRST (ChannelKind::Leaky here, but preserve the
    // ChainedStreamOf deadlock note for both): closing wakes a poll-blocked
    // read (EOS) and, for a FIFO channel, a backpressure-blocked source push,
    // so the source releases its dispatch mutex before we unsubscribe.
    {
      auto ref = leftCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    {
      auto ref = rightCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    leftPub_.reset();  // unsubscribe — source parks if we were its last demand
    rightPub_.reset();
    { *leftCh_.ref() = nullptr; }
    { *rightCh_.ref() = nullptr; }
    lastRight_.reset(); // stale across activations
  }

  ConvertedFrame::Ptr iterate() override {
    TapChannel::Ptr lch, rch;
    {
      auto ref = leftCh_.ref();
      lch = *ref;
    }
    {
      auto ref = rightCh_.ref();
      rch = *ref;
    }
    if (!lch || !rch)
      throw StopIteration();
    // Block on the LEFT channel — the pacing side (caller passes left first).
    OwnedFrame::Ptr left;
    try {
      if (!lch->poll(left, /*wait=*/true))
        return nullptr; // spurious wake (Leaky) — the base yields
    } catch (Threading::EOS &) {
      throw StopIteration(); // left source terminated / our teardown
    }
    if (!left)
      return nullptr;
    // Drain the RIGHT channel non-blocking, keeping only the newest; retain the
    // last-seen right frame across ticks (latest-wins pairing).
    try {
      OwnedFrame::Ptr r;
      while (rch->poll(r, /*wait=*/false))
        lastRight_ = r;
    } catch (Threading::EOS &) {
      throw StopIteration(); // right source terminated
    }
    if (!lastRight_)
      return nullptr; // no right frame yet — skip this left arrival
    return process(left, lastRight_);
  }

private:
  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &left,
                              const OwnedFrame::Ptr &right) {
    const int64_t t = converterNowMs();
    // Left ingest + latest-wins drops (this brick outran by the tap).
    if (lastLeftSeq_ && left->seq > lastLeftSeq_ + 1)
      meter_.drop(left->seq - lastLeftSeq_ - 1);
    lastLeftSeq_ = left->seq;
    meter_.ingest("left", t);
    // Right ingest per drained arrival: one consumed + the superseded ones
    // (seq delta) metered as drops (latest-wins — expected under mismatched
    // owner clocks).
    if (right->seq != lastRightSeq_) {
      if (lastRightSeq_ && right->seq > lastRightSeq_ + 1)
        meter_.drop(right->seq - lastRightSeq_ - 1);
      lastRightSeq_ = right->seq;
      meter_.ingest("right", t);
    }

    if (hasPending_.exchange(false, std::memory_order_acquire)) {
      params_ = *pending_.ref();
      matcher_.release(); // rebuilt lazily below with the new params
    }

    // Unequal L/R dims → drop (the transient during steering/retune).
    if (left->mat.cols != right->mat.cols ||
        left->mat.rows != right->mat.rows) {
      meter_.drop(); // reason: dims-mismatch
      return nullptr;
    }
    const int iw = left->mat.cols, ih = left->mat.rows;
    if (iw <= 0 || ih <= 0) {
      meter_.drop(); // reason: empty
      return nullptr;
    }

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    if (!matcher_)
      matcher_ = buildMatcher(params_);
    // BGRA → GRAY both sides (SGBM wants single-channel 8-bit).
    toGray(left->mat, leftGray_);
    toGray(right->mat, rightGray_);
    matcher_->compute(leftGray_, rightGray_, disp16_);   // CV_16S fixed-point
    disp16_.convertTo(dispF32_, CV_32F, 1.0 / 16.0);     // full-res float
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    activePacked_.store(pack(left->originX, left->originY, iw, ih),
                        std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = dispF32_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = left->format;                 // cosmetic (mat.type() is F32)
    cf->deviceTimestamp = left->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = left->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = left->originX; // disparity is in LEFT-frame coordinates
    cf->originY = left->originY;
    meter_.emit("disparity", converterNowMs());
    return cf;
  }

  static cv::Ptr<cv::StereoSGBM> buildMatcher(const StereoParams &p) {
    const int cn = 1; // grayscale
    const int bs = p.blockSize;
    return cv::StereoSGBM::create(
        p.minDisparity, p.numDisparities, bs,
        /*P1=*/8 * cn * bs * bs, /*P2=*/32 * cn * bs * bs,
        /*disp12MaxDiff=*/1, /*preFilterCap=*/0, /*uniquenessRatio=*/5,
        /*speckleWindowSize=*/50, /*speckleRange=*/2, cv::StereoSGBM::MODE_SGBM);
  }
  static void toGray(const cv::Mat &in, cv::Mat &out) {
    if (in.channels() == 4)
      cv::cvtColor(in, out, cv::COLOR_BGRA2GRAY);
    else if (in.channels() == 3)
      cv::cvtColor(in, out, cv::COLOR_BGR2GRAY);
    else
      out = in; // already single-channel
  }
  static uint64_t pack(uint32_t x, uint32_t y, int w, int h) {
    return (static_cast<uint64_t>(static_cast<uint16_t>(x)) << 48) |
           (static_cast<uint64_t>(static_cast<uint16_t>(y)) << 32) |
           (static_cast<uint64_t>(static_cast<uint16_t>(w)) << 16) |
           static_cast<uint64_t>(static_cast<uint16_t>(h));
  }
  static cv::Rect unpack(uint64_t v) {
    return cv::Rect(static_cast<int>((v >> 48) & 0xffff),
                    static_cast<int>((v >> 32) & 0xffff),
                    static_cast<int>((v >> 16) & 0xffff),
                    static_cast<int>(v & 0xffff));
  }

  void closeChains() {
    {
      auto ref = leftCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    {
      auto ref = rightCh_.ref();
      if (*ref)
        (*ref)->close();
    }
  }

  const Source left_, right_; // shared: keep the upstream bricks alive
  const std::string name_;
  const std::string leftId_, rightId_; // upstream node ids (topology edges)
  const uint32_t maxW_, maxH_;
  ChannelKind kind_{}; // Leaky (latest-wins) for both inputs

  Threading::Guard<TapChannel::Ptr> leftCh_{nullptr};
  Threading::Guard<TapChannel::Ptr> rightCh_{nullptr};
  std::unique_ptr<TapPublisher> leftPub_;  // exists only while active
  std::unique_ptr<TapPublisher> rightPub_;
  OwnedFrame::Ptr lastRight_; // retained newest right frame (brick thread only)

  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat leftGray_, rightGray_, disp16_, dispF32_; // reused buffers (this thread)
  cv::Ptr<cv::StereoSGBM> matcher_;                 // rebuilt on param change
  StereoParams params_;                             // current spec (this thread)
  Threading::Guard<StereoParams> pending_ = {StereoParams{}};
  std::atomic<bool> hasPending_{false};
  uint64_t lastLeftSeq_ = 0, lastRightSeq_ = 0; // brick thread only
  std::atomic<uint64_t> activePacked_{0};       // last produced {origin, w/h}
};

// Cross-brick lookup (HeatmapStream chains on a stereo pipe): the live stereo
// brick bound to `pipeId`, or nullptr. Defined in StereoStream.cpp (owns the
// registry); NAPI-thread only.
StereoStream::Ptr findStereo(const std::string &pipeId);

} // namespace Arv
