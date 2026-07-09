// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// split-disparity-nodes §"Scale node = a NEW native chained brick": a general-
// purpose RESIZE brick, modelled exactly on the FOVEA CROP brick (FoveaStream).
// Input is another brick's OwnedFrame tap (any convert / undistort / fovea
// pipe — Leaky/latest-wins, demand propagation keeps the upstream chain awake).
// The product is a `cv::resize` of the input frame:
//   - INTER_AREA when the output is smaller than the input (shrinking),
//     INTER_LINEAR otherwise (growing).
//   - Output dims are recomputed PER FRAME from the REACTIVE params + that
//     frame's ACTIVE input dims, so variable-size sources (a slice/fovea pipe)
//     just work.
//   - The source frame's crop ORIGIN is forwarded UNSCALED (source full-res
//     coords) in the v4 slot header, alongside the active OUT dims — consumers
//     un-scale rect coords with the ratio they commanded, then add the origin.
//   - deviceTimestamp/systemTimestamp are forwarded from the source frame
//     (trusted-time invariant: timestamps between nodes are ALWAYS trusted).
//
// Params stay LIVE-updatable (fovea setRect pattern: guarded pending + atomic
// flag, applied on the next frame) — exactly one of
//   { ratio } | { dwidth } | { dheight } | { dsize:{width,height} }
// where dwidth/dheight preserve the input aspect. Output dims are clamped to
// the ring's max footprint (never exceed maxBytes), like the fovea rect clamp.
// Demand propagation is the ChainedStream contract: this brick runs iff its
// pipe has consumers (or a downstream tap subscribes); while running, its tap
// keeps the whole upstream chain awake.

#include <atomic>
#include <cmath>
#include <stdexcept>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>

#include "ConverterStream.h" // ChainedStream, ConvertedFrame, OwnedFrame, ...

namespace Arv {

// The reactive resize spec: EXACTLY one mode is meaningful per instance. Built
// (and validated) on the NAPI thread from the JS params object, then applied on
// the brick thread. `compute()` turns it + the active input dims into the
// output dims, preserving aspect for the width-/height-only modes.
struct ScaleParams {
  enum class Mode { Ratio, DWidth, DHeight, DSize } mode = Mode::Ratio;
  double ratio = 1.0; // Mode::Ratio
  uint32_t width = 0; // Mode::DWidth / Mode::DSize
  uint32_t height = 0; // Mode::DHeight / Mode::DSize

  // Output dims for an input of (iw, ih). Never returns a zero dim (clamped to
  // ≥1). Aspect preserved for the single-axis modes (rounded to nearest int).
  cv::Size compute(int iw, int ih) const {
    if (iw <= 0 || ih <= 0)
      return {0, 0};
    int ow = iw, oh = ih;
    switch (mode) {
    case Mode::Ratio:
      ow = static_cast<int>(std::lround(iw * ratio));
      oh = static_cast<int>(std::lround(ih * ratio));
      break;
    case Mode::DWidth:
      ow = static_cast<int>(width);
      oh = static_cast<int>(std::lround(static_cast<double>(ih) * width / iw));
      break;
    case Mode::DHeight:
      oh = static_cast<int>(height);
      ow = static_cast<int>(std::lround(static_cast<double>(iw) * height / ih));
      break;
    case Mode::DSize:
      ow = static_cast<int>(width);
      oh = static_cast<int>(height);
      break;
    }
    return {std::max(1, ow), std::max(1, oh)};
  }
};

class ScaleStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<ScaleStream>;
  // `source` = the upstream brick (convert / undistort / fovea); `sourceId` =
  // its node id (topology edge). `name` = the pipe/node id. maxW/maxH = the
  // ring's footprint cap.
  static Ptr create(Source source, std::string sourceId, std::string name,
                    const ScaleParams &params, uint32_t maxW, uint32_t maxH) {
    return std::make_shared<ScaleStream>(std::move(source), std::move(sourceId),
                                         std::move(name), params, maxW, maxH);
  }
  ScaleStream(Source source, std::string sourceId, std::string name,
              const ScaleParams &params, uint32_t maxW, uint32_t maxH)
      : ChainedStream(std::move(source)), name_(name),
        sourceId_(std::move(sourceId)), maxW_(maxW), maxH_(maxH),
        params_(params),
        meter_(std::move(name), {"frame"}, {"scale"}, converterNowMs()) {}
  ~ScaleStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  // Live retune (reactive params): applied on the NEXT frame.
  void setParams(const ScaleParams &p) {
    *pending_.ref() = p;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The active OUT size + forwarded origin of the LAST produced frame, for
  // scaleProbeAll (mirrors FoveaStream::activeRect — {originX,originY,w,h}).
  cv::Rect activeRect() const {
    return unpack(activePacked_.load(std::memory_order_acquire));
  }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }

protected:
  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &in) override {
    const int64_t t = converterNowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran this brick (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);
    if (hasPending_.exchange(false, std::memory_order_acquire))
      params_ = *pending_.ref();

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    const int iw = in->mat.cols, ih = in->mat.rows;
    cv::Size out = clampFootprint(params_.compute(iw, ih));
    if (out.width <= 0 || out.height <= 0 || iw <= 0 || ih <= 0) {
      meter_.end(converterNowMs());
      return nullptr;
    }
    // INTER_AREA when shrinking (output < input), INTER_LINEAR when growing.
    const int interp = (out.width < iw || out.height < ih) ? cv::INTER_AREA
                                                           : cv::INTER_LINEAR;
    cv::resize(in->mat, buf_, out, 0, 0, interp);
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    activePacked_.store(pack(in->originX, in->originY, out.width, out.height),
                        std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = in->format;
    cf->deviceTimestamp = in->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = in->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = in->originX; // crop origin forwarded UNSCALED (source coords)
    cf->originY = in->originY;
    meter_.emit("scale", converterNowMs());
    return cf;
  }

private:
  cv::Size clampFootprint(cv::Size s) const {
    s.width = std::min<int>(s.width, static_cast<int>(maxW_));
    s.height = std::min<int>(s.height, static_cast<int>(maxH_));
    return s;
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

  const std::string name_;
  const std::string sourceId_; // upstream brick's node id (topology edge)
  const uint32_t maxW_, maxH_;
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused scaled output (this thread only)
  ScaleParams params_;       // current resize spec (this thread only)
  Threading::Guard<ScaleParams> pending_ = {ScaleParams{}};
  std::atomic<bool> hasPending_{false};
  std::atomic<uint64_t> activePacked_{0}; // last produced {origin, out w/h}
};

// Cross-brick lookup (ScaleStream chaining on another scale pipe): the live
// scale brick bound to `pipeId`, or nullptr. Defined in ScaleStream.cpp (owns
// the registry); NAPI-thread only.
ScaleStream::Ptr findScale(const std::string &pipeId);

} // namespace Arv
