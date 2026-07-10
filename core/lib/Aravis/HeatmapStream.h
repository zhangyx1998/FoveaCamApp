// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// stereo-disparity-and-heatmap-nodes §"HeatmapStream (pinned)": a plain
// single-input chained brick (ScaleStream's exact shape) that colormaps a
// 1-channel input (CV_32FC1 or CV_8UC1) to BGRA8 so the output matches every
// other BGRA8 pipe. Input is another brick's OwnedFrame tap (normally a stereo
// disparity pipe — Leaky/latest-wins; demand propagation keeps the upstream
// chain awake).
//
// Normalize to [0,255] U8 by reactive { min?, max? } (each field independent —
// an absent field is auto-filled from THAT frame's minMaxLoc), then
// cv::applyColorMap(COLORMAP_TURBO) → BGR → BGRA (alpha 255). Active dims +
// origin + timestamps are forwarded from the source frame (trusted-time).
// Anything but CV_32FC1 / CV_8UC1 is dropped (meter_.drop, reason
// "unsupported-format").

#include <atomic>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>

#include "ConverterStream.h" // ChainedStream, ConvertedFrame, OwnedFrame, ...

namespace Arv {

// Reactive colormap normalization spec. Both fields independent: `hasMin`/
// `hasMax` gate whether the fixed bound is used or auto-derived per frame.
struct HeatmapParams {
  bool hasMin = false;
  bool hasMax = false;
  double min = 0.0;
  double max = 0.0;
};

class HeatmapStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<HeatmapStream>;
  static Ptr create(Source source, std::string sourceId, std::string name,
                    const HeatmapParams &params, uint32_t maxW, uint32_t maxH) {
    return std::make_shared<HeatmapStream>(std::move(source),
                                           std::move(sourceId), std::move(name),
                                           params, maxW, maxH);
  }
  HeatmapStream(Source source, std::string sourceId, std::string name,
                const HeatmapParams &params, uint32_t maxW, uint32_t maxH)
      : ChainedStream(std::move(source)), name_(name),
        sourceId_(std::move(sourceId)), maxW_(maxW), maxH_(maxH),
        params_(params),
        meter_(std::move(name), {"frame"}, {"heatmap"}, converterNowMs()) {}
  ~HeatmapStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  // Live retune (reactive params): applied on the NEXT frame.
  void setParams(const HeatmapParams &p) {
    *pending_.ref() = p;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
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

    const int type = in->mat.type();
    if (type != CV_32FC1 && type != CV_8UC1) {
      meter_.drop(); // reason: unsupported-format
      return nullptr;
    }

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    // Normalize to U8 [0,255]: each bound independent (absent → per-frame auto).
    double lo = params_.min, hi = params_.max;
    if (!params_.hasMin || !params_.hasMax) {
      double fmin = 0, fmax = 0;
      cv::minMaxLoc(in->mat, &fmin, &fmax);
      if (!params_.hasMin)
        lo = fmin;
      if (!params_.hasMax)
        hi = fmax;
    }
    const double span = hi - lo;
    const double scale = span > 0 ? 255.0 / span : 0.0;
    in->mat.convertTo(u8_, CV_8U, scale, -lo * scale);
    cv::applyColorMap(u8_, bgr_, cv::COLORMAP_TURBO);   // BGR CV_8UC3
    cv::cvtColor(bgr_, buf_, cv::COLOR_BGR2RGBA);        // honest RGBA8, alpha 255
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    activePacked_.store(
        pack(in->originX, in->originY, buf_.cols, buf_.rows),
        std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = RGBA8;
    cf->deviceTimestamp = in->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = in->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = in->originX; // forwarded from the source frame
    cf->originY = in->originY;
    meter_.emit("heatmap", converterNowMs());
    return cf;
  }

private:
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
  cv::Mat u8_, bgr_, buf_;   // reused normalize/colormap/BGRA buffers (this thread)
  HeatmapParams params_;     // current colormap spec (this thread only)
  Threading::Guard<HeatmapParams> pending_ = {HeatmapParams{}};
  std::atomic<bool> hasPending_{false};
  std::atomic<uint64_t> activePacked_{0}; // last produced {origin, out w/h}
};

// Cross-brick lookup (a heatmap chained on another heatmap): the live heatmap
// brick bound to `pipeId`, or nullptr. Defined in HeatmapStream.cpp (owns the
// registry); NAPI-thread only.
HeatmapStream::Ptr findHeatmap(const std::string &pipeId);

} // namespace Arv
