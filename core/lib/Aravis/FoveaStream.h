// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// unified-time-and-topology §5 (B, native re-plumb): the FOVEA CROP brick v2.
// Input is another brick's OwnedFrame tap (normally the UNDISTORT brick —
// chain convert → undistort → fovea; a convert brick works too for raw
// crops). The crop is a PLAIN ROI copy of the input frame — the fused map-ROI
// convert+remap of v1 is retired: undistortion happens ONCE upstream and N
// foveas share it (the id `.../undistort/fovea/<slot>` finally matches the
// physical dataflow). C-20 semantics on the SHM pipe are unchanged: dynamic
// pipe, max-footprint ring, per-frame active w/h + FRAME-BOUND originX/originY
// in the v4 slot header, epoch reuse-safe ids.
//
// The crop rect stays LIVE-updatable (KCF arm() pattern: guarded pending +
// atomic flag, applied on the next frame, clamped to frame domain + max
// footprint) — multi-fovea steers crops per tick with no re-attach/gate churn.
// Demand propagation is the ChainedStream contract: this brick runs iff its
// pipe has consumers (or a downstream tap subscribes); while running, its tap
// keeps the whole upstream chain awake.

#include <atomic>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>

#include "ConverterStream.h" // ChainedStream, ConvertedFrame, OwnedFrame, ...

namespace Arv {

class FoveaStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<FoveaStream>;
  // `source` = the upstream brick (undistort, or convert for raw crops);
  // `sourceId` = its node id (topology edge). `name` = the pipe/node id.
  // maxW/maxH = the ring's footprint cap. `undistorted` = the source produces
  // undistorted frames (probe surface only).
  static Ptr create(Source source, std::string sourceId, std::string name,
                    const cv::Rect &rect, uint32_t maxW, uint32_t maxH,
                    bool undistorted) {
    return std::make_shared<FoveaStream>(std::move(source),
                                         std::move(sourceId), std::move(name),
                                         rect, maxW, maxH, undistorted);
  }
  FoveaStream(Source source, std::string sourceId, std::string name,
              const cv::Rect &rect, uint32_t maxW, uint32_t maxH,
              bool undistorted)
      : ChainedStream(std::move(source)), name_(name),
        sourceId_(std::move(sourceId)), maxW_(maxW), maxH_(maxH),
        undistorted_(undistorted),
        meter_(std::move(name), {"frame"}, {"fovea"}, converterNowMs()) {
    setRect(rect);
  }
  ~FoveaStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  // Live steering (multi-fovea per-tick): applied on the NEXT frame.
  void setRect(const cv::Rect &r) {
    *pending_.ref() = r;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The rect of the LAST produced fovea (post-clamp), for foveaProbeAll.
  cv::Rect activeRect() const {
    return unpack(activePacked_.load(std::memory_order_acquire));
  }
  // True when the SOURCE brick produces undistorted frames (this brick itself
  // only crops — the flag mirrors what space the crop lives in).
  bool undistorted() const { return undistorted_; }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }

protected:
  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &in) override {
    const int64_t t = converterNowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran this brick (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);
    if (hasPending_.exchange(false, std::memory_order_acquire))
      rect_ = clampFootprint(*pending_.ref());

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    cv::Rect r = rect_ & cv::Rect(0, 0, in->mat.cols, in->mat.rows);
    if (r.empty()) {
      meter_.end(converterNowMs());
      return nullptr;
    }
    in->mat(r).copyTo(buf_); // plain ROI crop into the reused output buffer
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    activePacked_.store(pack(r), std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = in->format;
    cf->deviceTimestamp = in->deviceTimestamp;
    cf->systemTimestamp = in->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = static_cast<uint32_t>(r.x); // frame-bound crop origin,
    cf->originY = static_cast<uint32_t>(r.y); // in SOURCE-frame coordinates
    meter_.emit("fovea", converterNowMs());
    return cf;
  }

private:
  cv::Rect clampFootprint(cv::Rect r) const {
    if (r.x < 0)
      r.x = 0;
    if (r.y < 0)
      r.y = 0;
    r.width = std::min<int>(r.width, static_cast<int>(maxW_));
    r.height = std::min<int>(r.height, static_cast<int>(maxH_));
    return r; // frame-domain intersection happens per-frame in process()
  }
  static uint64_t pack(const cv::Rect &r) {
    return (static_cast<uint64_t>(static_cast<uint16_t>(r.x)) << 48) |
           (static_cast<uint64_t>(static_cast<uint16_t>(r.y)) << 32) |
           (static_cast<uint64_t>(static_cast<uint16_t>(r.width)) << 16) |
           static_cast<uint64_t>(static_cast<uint16_t>(r.height));
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
  const bool undistorted_;
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused fovea output (this thread only)
  cv::Rect rect_;            // current crop request (this thread only)
  Threading::Guard<cv::Rect> pending_ = {cv::Rect()};
  std::atomic<bool> hasPending_{false};
  std::atomic<uint64_t> activePacked_{0}; // last produced rect (probe surface)
};

// Cross-brick lookup (ScaleStream chaining on a fovea/slice pipe): the live
// fovea brick bound to `pipeId`, or nullptr. Defined in FoveaStream.cpp (owns
// the registry); NAPI-thread only.
FoveaStream::Ptr findFovea(const std::string &pipeId);

} // namespace Arv
