// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// real-2 (B-24): the FOVEA CROP brick — a spawn/cancel-able per-fovea producer
// thread feeding a DYNAMIC pipe (C-20 semantics: max-footprint ring, per-frame
// active w/h in the slot header, epoch reuse-safe ids).
//
// FUSED map-ROI design (B-24 ruling Q1): the thread subscribes the RAW camera
// stream and does convert → ROI-remap in ONE pass. The identity that makes the
// undistorted crop both EXACT and CHEAP: `cv::remap` through the dest-ROI
// SUBMATS of the attach-time full maps (`map1_(rect), map2_(rect)`) yields
// precisely the `rect` crop of the full undistorted image (maps are per-dest-
// pixel absolute source coordinates) at fovea-sized remap cost. No chaining
// off UndistortStream (B-23: downstream Sub::Latest is contract-unsafe on the
// reused buffer), no lifetime coupling — cancelling the wide undistort pipe
// never kills foveas; the physical graph edge is camera → fovea. The copy-seam
// republisher (undistort once, N crops) stays the documented revisit-at-large-N
// alternative; full-frame convert per fovea is v1-accepted (bbox-limited
// convert = metered follow-up, ruling Q5).
//
// Raw mode (no calibration): same node, plain rect crop of the converted frame.
// The crop rect is LIVE-updatable via the KCF arm() pattern (guarded pending +
// atomic flag, applied on the next frame, clamped to domain + max footprint) —
// multi-fovea steers crops per tick with no re-attach/gate churn. The active
// rect is FRAME-BOUND: it rides each ConvertedFrame (originX/originY + mat
// dims), never a racy side-channel echo.

#include <atomic>

#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>
#include <Vision.h> // CameraCalibration

#include "ConverterStream.h" // ConvertedFrame, PipeOfferSubscriber, converterNowMs

namespace Arv {

class FoveaStream : public TransformStream<Frame::Ptr, ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<FoveaStream>;
  // `cal` nullable: with a calibration the fovea is an UNDISTORTED crop
  // (map-ROI remap); without, a raw crop. `name` = the pipe/node id (meter
  // names ARE node ids, B-24). maxW/maxH = the ring's footprint cap.
  static Ptr create(Arv::Stream::Ptr upstream, PixelFormat target,
                    std::string name, const cv::Rect &rect,
                    const CameraCalibration::Ptr &cal, uint32_t maxW,
                    uint32_t maxH) {
    return std::make_shared<FoveaStream>(std::move(upstream), target,
                                         std::move(name), rect, cal, maxW,
                                         maxH);
  }
  FoveaStream(Arv::Stream::Ptr upstream, PixelFormat target, std::string name,
              const cv::Rect &rect, const CameraCalibration::Ptr &cal,
              uint32_t maxW, uint32_t maxH)
      : upstream_(std::move(upstream)), target_(target), maxW_(maxW),
        maxH_(maxH),
        meter_(std::move(name), {"frame"}, {"fovea"}, converterNowMs()) {
    if (cal) { // sync map build at attach (B-23 ruling #4 precedent)
      const auto &mtx = cal->camera_matrix;
      cv::initUndistortRectifyMap(mtx, cal->dist_coeffs, {}, mtx,
                                  cal->sensor_size, CV_32FC1, map1_, map2_);
    }
    setRect(rect);
  }
  ~FoveaStream() override { shutdown(); }

  // Live steering (multi-fovea per-tick): applied on the NEXT frame.
  void setRect(const cv::Rect &r) {
    *pending_.ref() = r;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The rect of the LAST produced fovea (post-clamp), for foveaProbeAll.
  cv::Rect activeRect() const { return unpack(activePacked_.load(std::memory_order_acquire)); }
  bool undistorted() const { return !map1_.empty(); }

protected:
  Stream<Frame::Ptr> *upstream() override { return upstream_.get(); }

  ConvertedFrame::Ptr transform(const Frame::Ptr &frame) override {
    const int64_t t = converterNowMs();
    const uint64_t d = upstreamDrops();
    if (d > lastDrops_) {
      meter_.drop(d - lastDrops_);
      lastDrops_ = d;
    }
    meter_.ingest("frame", t);
    if (hasPending_.exchange(false, std::memory_order_acquire))
      rect_ = clampFootprint(*pending_.ref());

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    convertFrame(frame->raw, frame->format, target_, tmp_); // full frame (v1)
    cv::Rect r = rect_;
    if (undistorted()) {
      // Geometry guard: maps are sensor-size; any other source geometry
      // (ROI/binning change ⇒ re-advertise + re-attach) is dropped.
      if (tmp_.size() != map1_.size()) {
        meter_.end(converterNowMs());
        return nullptr;
      }
      r &= cv::Rect(0, 0, map1_.cols, map1_.rows); // frame-bound clamp
      if (r.empty()) {
        meter_.end(converterNowMs());
        return nullptr;
      }
      // THE map-ROI identity: dest-ROI submats of the full maps ⇒ the exact
      // `r` crop of the full undistorted image, at r-sized remap cost.
      cv::remap(tmp_, buf_, map1_(r), map2_(r), cv::INTER_LINEAR);
    } else {
      r &= cv::Rect(0, 0, tmp_.cols, tmp_.rows);
      if (r.empty()) {
        meter_.end(converterNowMs());
        return nullptr;
      }
      tmp_(r).copyTo(buf_); // raw crop into the reused output buffer
    }
    const double processMs =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - c0)
            .count();
    meter_.end(converterNowMs());
    activePacked_.store(pack(r), std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->deviceTimestamp = frame->device_timestamp;
    cf->systemTimestamp = frame->system_timestamp;
    cf->convertMs = processMs;
    cf->originX = static_cast<uint32_t>(r.x); // frame-bound crop origin
    cf->originY = static_cast<uint32_t>(r.y);
    meter_.emit("fovea", converterNowMs());
    return cf;
  }

private:
  cv::Rect clampFootprint(cv::Rect r) const {
    if (r.x < 0) r.x = 0;
    if (r.y < 0) r.y = 0;
    r.width = std::min<int>(r.width, static_cast<int>(maxW_));
    r.height = std::min<int>(r.height, static_cast<int>(maxH_));
    return r; // frame/map-domain intersection happens per-frame in transform
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

  Arv::Stream::Ptr upstream_;
  const PixelFormat target_;
  const uint32_t maxW_, maxH_;
  Meter::ThreadMeter meter_;  // single writer = this transform thread
  cv::Mat map1_, map2_;       // full sensor maps (empty ⇒ raw-crop mode)
  cv::Mat tmp_;               // reused convert target (transform thread only)
  cv::Mat buf_;               // reused fovea output (transform thread only)
  cv::Rect rect_;             // current crop request (transform thread only)
  Threading::Guard<cv::Rect> pending_ = {cv::Rect()};
  std::atomic<bool> hasPending_{false};
  std::atomic<uint64_t> activePacked_{0}; // last produced rect (probe surface)
  uint64_t lastDrops_ = 0;    // transform-thread only
};

} // namespace Arv
