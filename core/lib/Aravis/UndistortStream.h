// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// unified-time-and-topology §5 (B, native re-plumb): the UNDISTORT brick v2.
// Input is the CONVERTER's in-process OwnedFrame tap (BGRA/converted only —
// NEVER the raw Bayer Arv::Stream; raw never leaves the converter). Two
// variants, selected at construction:
//   - INTRINSIC: classic `cv::remap` with maps precomputed at attach from the
//     persisted CameraCalibration JSON (`cv::initUndistortRectifyMap`) —
//     cached-maps behavior unchanged from v1 (center camera).
//   - HOMOGRAPHY: per-frame `cv::warpPerspective` with H looked up from the
//     native ParamRing by the frame's host time
//     (`hostNs = deviceTimestamp + clockOffsetNs`; offset settable via the
//     `setClockOffset` NAPI, default 0 = uncalibrated — marked in the probe).
//     An empty ring passes frames through untouched (startup-safe).
// Demand propagation is the ChainedStream contract: this brick runs iff its
// SHM pipe has consumers OR a downstream tap (fovea) subscribes; while it
// runs, its tap on the converter keeps the converter awake — even with zero
// convert-pipe SHM consumers. Parked ⇔ no demand, across both transports.
//
// Products are `ConvertedFrame`s under the SAME reused-buffer contract as
// ConverterStream (valid only during synchronous dispatch); the pipe producer
// is the shared gated `PipeOfferSubscriber`; downstream bricks tap via
// `TapPublisher` (which deep-copies before the buffer is reused).

#include <atomic>

#include <opencv2/opencv.hpp>

#include <Vision.h> // CameraCalibration

#include "ConverterStream.h" // ChainedStream, ConvertedFrame, OwnedFrame, ...
#include "ParamRing.h"

namespace Arv {

class UndistortStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<UndistortStream>;
  enum class Variant { Intrinsic, Homography };

  // INTRINSIC variant. Maps built SYNCHRONOUSLY here (attach, NAPI thread —
  // tens of ms once per session-open, B-23 ruling #4), owned by the stream
  // (2× CV_32FC1 sensor-size Mats), freed with the stream.
  static Ptr create(Source source, std::string sourceId,
                    const CameraCalibration::Ptr &cal, std::string name) {
    return std::make_shared<UndistortStream>(std::move(source),
                                             std::move(sourceId), cal,
                                             std::move(name));
  }
  UndistortStream(Source source, std::string sourceId,
                  const CameraCalibration::Ptr &cal, std::string name)
      : ChainedStream(std::move(source)), variant_(Variant::Intrinsic),
        name_(name), sourceId_(std::move(sourceId)),
        ring_(2), // unused by this variant — minimum footprint
        meter_(std::move(name), {"frame"}, {"undistorted"}, converterNowMs()) {
    const auto &mtx = cal->camera_matrix;
    const auto &dist = cal->dist_coeffs;
    cv::initUndistortRectifyMap(mtx, dist, {}, mtx, cal->sensor_size, CV_32FC1,
                                map1_, map2_);
  }

  // HOMOGRAPHY variant (L/R mirror-steered cameras).
  static Ptr create(Source source, std::string sourceId, size_t ringCapacity,
                    std::string name) {
    return std::make_shared<UndistortStream>(
        std::move(source), std::move(sourceId), ringCapacity, std::move(name));
  }
  UndistortStream(Source source, std::string sourceId, size_t ringCapacity,
                  std::string name)
      : ChainedStream(std::move(source)), variant_(Variant::Homography),
        name_(name), sourceId_(std::move(sourceId)), ring_(ringCapacity),
        meter_(std::move(name), {"frame"}, {"undistorted"}, converterNowMs()) {}

  ~UndistortStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  // --- homography-variant control surface (NAPI thread) --------------------
  // Push one {hostNs, H[9] row-major} sample (≤ ~1 kHz). No-op guard: only
  // meaningful for the Homography variant (callers check `variant()`).
  void pushHomography(int64_t hostNs, const double *h9) {
    ring_.push(hostNs, h9);
  }
  // Camera-device → host clock offset (ns): hostNs = deviceTimestamp + offset.
  void setClockOffset(int64_t offsetNs) {
    clockOffsetNs_.store(offsetNs, std::memory_order_release);
    clockCalibrated_.store(true, std::memory_order_release);
  }

  // --- probes ---------------------------------------------------------------
  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  Variant variant() const { return variant_; }
  const char *variantName() const {
    return variant_ == Variant::Intrinsic ? "intrinsic" : "homography";
  }
  bool calibratedClock() const {
    return clockCalibrated_.load(std::memory_order_acquire);
  }
  // Frames passed through untouched (homography variant with an empty ring).
  uint64_t passthroughCount() const {
    return passthrough_.load(std::memory_order_relaxed);
  }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }

protected:
  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &in) override {
    const int64_t t = converterNowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran this brick (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    if (variant_ == Variant::Intrinsic) {
      // Geometry guard: the maps are sensor-size; a frame of any other
      // geometry (ROI/binning change ⇒ A re-advertises + re-attaches) must be
      // dropped — remap would blindly sample off-grid.
      if (in->mat.size() != map1_.size()) {
        meter_.end(converterNowMs());
        return nullptr; // base loop + subscribers tolerate null
      }
      cv::remap(in->mat, buf_, map1_, map2_, cv::INTER_LINEAR);
    } else {
      const int64_t hostNs =
          static_cast<int64_t>(in->deviceTimestamp) +
          clockOffsetNs_.load(std::memory_order_acquire);
      ParamRing::Params h;
      if (ring_.lookup(hostNs, h)) {
        const cv::Mat H(3, 3, CV_64F, h.data());
        cv::warpPerspective(in->mat, buf_, H, in->mat.size(),
                            cv::INTER_LINEAR);
      } else { // no mirror history yet — passthrough, marked in the probe
        in->mat.copyTo(buf_);
        passthrough_.fetch_add(1, std::memory_order_relaxed);
      }
    }
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = in->format; // passthrough typing (input is already converted)
    cf->deviceTimestamp = in->deviceTimestamp;
    cf->systemTimestamp = in->systemTimestamp;
    cf->convertMs = processMs; // this brick's ms (upstream ms rides the tap)
    meter_.emit("undistorted", converterNowMs());
    return cf;
  }

private:
  const Variant variant_;
  const std::string name_;
  const std::string sourceId_; // the converter brick's node id (topology edge)
  cv::Mat map1_, map2_;        // intrinsic maps (attach-time; thread-read-only)
  ParamRing ring_;             // homography history (JS writer / this reader)
  std::atomic<int64_t> clockOffsetNs_{0};
  std::atomic<bool> clockCalibrated_{false};
  std::atomic<uint64_t> passthrough_{0};
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused output buffer (this thread only)
};

// Cross-brick lookup (FoveaStream attach by undistort pipeId): the live
// undistort brick bound to `pipeId`, or nullptr. Defined in
// UndistortStream.cpp (owns the registry); NAPI-thread only.
UndistortStream::Ptr findUndistort(const std::string &pipeId);

} // namespace Arv
