// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// composite-node-and-center-select-fix §B: a two-input composite brick modelled
// on StereoStream (the FIRST two-input chained brick) but SIMPLER — no SGBM,
// just a per-pixel color op. Both inputs are OwnedFrame taps (Leaky/latest-wins)
// on any frame brick (undistort / convert / fovea / scale). It opens TWO
// TapPublishers in start() (closed in stop()) so demand propagates to BOTH
// sources; either source terminating ends the brick.
//
// Pairing: tick on every LEFT arrival, matched with the LATEST RIGHT frame
// (latest-wins; no seq comparison across cameras — different owner clocks pace
// them). iterate() BLOCKS on the left channel, then drains the right channel
// non-blocking keeping only the newest, retaining the last-seen right frame
// across ticks. No right frame yet → skip. Output timestamps/origin = the LEFT
// frame's (trusted-time: forwarded, never re-stamped). Active out dims = left.
//
// Compute (RGBA8 in ×2 → RGBA8 out, alpha 255), reactive params { mode, style }:
//   - anaglyph:   per-output-channel routing from the STYLE map (see
//                 kAnaglyphChannelSrc) — the LEFT frame drives its eye-color's
//                 channels, the RIGHT frame the other eye's, unused = 0. Default
//                 style RC = out.R←LEFT, out.G/B←RIGHT (red = LEFT eye, cyan =
//                 RIGHT — same parity as the retired DiffView mode + back-compat
//                 when `style` is absent).
//   - difference: cv::absdiff(L, R) on the color channels (alpha forced 255).
// Input dims must match AND both must be 4-channel (unequal / non-BGRA → drop +
// meter_.drop, the transient during steer/retune). The retune rebuilds nothing
// (the mode + style enums are applied directly on the next tick).

#include <atomic>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>

#include "ConverterStream.h" // TapPublisher, TapChannel, ChannelKind, ...

namespace Arv {

// The reactive composite spec — validated on the NAPI thread (see
// CompositeStream.cpp), applied on the brick thread (just the enums).
enum class CompositeMode { Anaglyph, Difference };

// Anaglyph STYLE = "<left-eye color>/<right-eye color>" (user ruling
// 2026-07-09): R = red, B = blue, C = cyan. Order MIRRORS
// docs/schema/anaglyph.ts `ANAGLYPH_STYLES` (RB, RC, BR, BC); RC is the
// back-compat default (red = LEFT, cyan = RIGHT).
enum class AnaglyphStyle { RB, RC, BR, BC };

struct CompositeParams {
  CompositeMode mode = CompositeMode::Anaglyph;
  AnaglyphStyle style = AnaglyphStyle::RC;
};

// Per-output-channel SOURCE for each style — HAND-MIRRORS the derived
// docs/schema/anaglyph.ts `ANAGLYPH_CHANNELS` (single source of truth; the
// drift guard is the pinned test core/test/27-composite-pipe.ts, which asserts
// RC + BR channel identity). Index [style][ch] where ch 0 = R (ch0), 1 = G
// (ch1), 2 = B (ch2). Value: 0 = take the LEFT frame's SAME channel, 1 = the
// RIGHT frame's, -1 = force 0. Derived under the conflict rule "left claims its
// color's channels first, right fills only what's free" — so B/C is
// {R:0-none, G:right, B:left} (left blue keeps ch2, right cyan keeps only ch1).
inline constexpr int kAnaglyphChannelSrc[4][3] = {
    /* RB */ {0, -1, 1}, // out.R←LEFT(red), out.G=0, out.B←RIGHT(blue)
    /* RC */ {0, 1, 1},  // out.R←LEFT(red), out.G←RIGHT, out.B←RIGHT (cyan)
    /* BR */ {1, -1, 0}, // out.R←RIGHT(red), out.G=0, out.B←LEFT(blue)
    /* BC */ {-1, 1, 0}, // out.R=0, out.G←RIGHT(cyan G), out.B←LEFT(blue)
};

// A two-source variant modelled on StereoStream: it owns two TapChannels + two
// TapPublishers. Output is a ConvertedFrame carrying a BGRA8 (CV_8UC4) mat.
class CompositeStream : public ::Stream<ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<CompositeStream>;
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

  static Ptr create(Source left, std::string leftId, Source right,
                    std::string rightId, std::string name,
                    const CompositeParams &params, uint32_t maxW,
                    uint32_t maxH) {
    return std::make_shared<CompositeStream>(
        std::move(left), std::move(leftId), std::move(right),
        std::move(rightId), std::move(name), params, maxW, maxH);
  }
  CompositeStream(Source left, std::string leftId, Source right,
                  std::string rightId, std::string name,
                  const CompositeParams &params, uint32_t maxW, uint32_t maxH)
      : left_(std::move(left)), right_(std::move(right)), name_(name),
        leftId_(std::move(leftId)), rightId_(std::move(rightId)), maxW_(maxW),
        maxH_(maxH), params_(params),
        meter_(std::move(name), {"left", "right"}, {"composite"},
               converterNowMs()) {}
  // NB: ::Stream<T>'s destructor is non-virtual, but this brick is only ever
  // held by shared_ptr (its type-erased deleter destructs the concrete type).
  ~CompositeStream() {
    closeChains(); // wake a blocked left poll (ChainedStream contract, both ends)
    shutdown();
  }

  // Live retune (reactive params): applied on the NEXT frame.
  void setParams(const CompositeParams &p) {
    *pending_.ref() = p;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The active OUT size + forwarded origin of the LAST produced frame (mirrors
  // StereoStream::activeRect — {originX, originY, w, h}).
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
      throw std::runtime_error(
          "composite chain source stream already terminated");
  }

  void stop() override {
    // Close BOTH channels FIRST (Leaky here, but preserve the ChainedStream
    // deadlock note for both): closing wakes a poll-blocked read (EOS) and, for
    // a FIFO channel, a backpressure-blocked source push, so the source releases
    // its dispatch mutex before we unsubscribe.
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
    leftPub_.reset(); // unsubscribe — source parks if we were its last demand
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

    if (hasPending_.exchange(false, std::memory_order_acquire))
      params_ = *pending_.ref();

    // Unequal L/R dims OR a non-BGRA input → drop (the transient during
    // steering/retune; every frame pipe is BGRA8 in steady state).
    if (left->mat.cols != right->mat.cols ||
        left->mat.rows != right->mat.rows) {
      meter_.drop(); // reason: dims-mismatch
      return nullptr;
    }
    if (left->mat.type() != CV_8UC4 || right->mat.type() != CV_8UC4) {
      meter_.drop(); // reason: unsupported-format
      return nullptr;
    }
    const int iw = left->mat.cols, ih = left->mat.rows;
    if (iw <= 0 || ih <= 0) {
      meter_.drop(); // reason: empty
      return nullptr;
    }

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    if (params_.mode == CompositeMode::Difference) {
      // |L − R| per channel; absdiff diffs ALL 4 channels (alpha 255−255 = 0),
      // so force alpha back to 255.
      cv::absdiff(left->mat, right->mat, buf_);
      setAlpha255(buf_);
    } else {
      // anaglyph: assemble each color channel from the STYLE map (0 = LEFT frame,
      // 1 = RIGHT frame, -1 = 0). Pipes are honest RGBA8 (channel-order-fix.md):
      // ch0 = R, ch1 = G, ch2 = B, ch3 = A. Zero the color planes + set alpha 255
      // up front (channels neither eye claims stay 0), then blit each eye's owned
      // channels FROM ITS OWN FRAME's SAME channel index.
      buf_.create(ih, iw, CV_8UC4);
      buf_.setTo(cv::Scalar(0, 0, 0, 255));
      const int(&src)[3] = kAnaglyphChannelSrc[static_cast<int>(params_.style)];
      int leftPairs[6], rightPairs[6];
      int nL = 0, nR = 0;
      for (int ch = 0; ch < 3; ++ch) {
        if (src[ch] == 0) {
          leftPairs[nL * 2] = ch;
          leftPairs[nL * 2 + 1] = ch;
          ++nL;
        } else if (src[ch] == 1) {
          rightPairs[nR * 2] = ch;
          rightPairs[nR * 2 + 1] = ch;
          ++nR;
        }
      }
      if (nL)
        cv::mixChannels(&left->mat, 1, &buf_, 1, leftPairs, nL);
      if (nR)
        cv::mixChannels(&right->mat, 1, &buf_, 1, rightPairs, nR);
    }
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    activePacked_.store(pack(left->originX, left->originY, iw, ih),
                        std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = RGBA8;
    cf->deviceTimestamp = left->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = left->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = left->originX; // composite is in LEFT-frame coordinates
    cf->originY = left->originY;
    meter_.emit("composite", converterNowMs());
    return cf;
  }

  // Force the BGRA alpha channel to a solid 255 (reused single-channel buffer).
  void setAlpha255(cv::Mat &m) {
    if (alpha_.rows != m.rows || alpha_.cols != m.cols)
      alpha_ = cv::Mat(m.rows, m.cols, CV_8UC1, cv::Scalar(255));
    const int fromTo[] = {0, 3}; // alpha (single-channel src) → buf channel 3
    cv::mixChannels(&alpha_, 1, &m, 1, fromTo, 1);
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
  cv::Mat buf_, alpha_;      // reused BGRA output + alpha buffers (this thread)
  CompositeParams params_;   // current spec (this thread)
  Threading::Guard<CompositeParams> pending_ = {CompositeParams{}};
  std::atomic<bool> hasPending_{false};
  uint64_t lastLeftSeq_ = 0, lastRightSeq_ = 0; // brick thread only
  std::atomic<uint64_t> activePacked_{0};       // last produced {origin, w/h}
};

} // namespace Arv
