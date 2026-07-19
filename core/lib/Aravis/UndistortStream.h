// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// The UNDISTORT brick v2.
// Input is the CONVERTER's in-process OwnedFrame tap (BGRA/converted only —
// NEVER the raw Bayer Arv::Stream; raw never leaves the converter). Two
// variants, selected at construction:
//   - INTRINSIC: classic `cv::remap` with maps precomputed at attach from the
//     persisted CameraCalibration JSON (`cv::initUndistortRectifyMap`) —
//     cached-maps behavior (center camera).
//   - HOMOGRAPHY: per-frame `cv::warpPerspective` with H looked up from the
//     native ParamRing by the frame's host time. Timestamps are OWNER-APPLIED:
//     the camera stamps every frame with its calibrated dt at Frame creation,
//     so the lookup uses
//     `hostNs = frame.deviceTimestamp` DIRECTLY — no per-brick offset. The
//     probe's `calibratedClock` reflects the CAMERA's calibration state
//     (ClockCalibration registry, keyed by the serial resolved at attach).
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
#include <thread>

#include <opencv2/opencv.hpp>

#include <Vision.h> // CameraCalibration

#include "ClockCalibration.h" // isClockCalibrated (camera clock state)
#include "ConverterStream.h"  // ChainedStream, ConvertedFrame, OwnedFrame, ...
#include "ParamRing.h"

namespace Arv {

class UndistortStream : public ChainedStream {
public:
  using Ptr = std::shared_ptr<UndistortStream>;
  enum class Variant { Intrinsic, Homography };
  // FIFO input capacity: the undistort
  // brick consumes the converter's OwnedFrame tap through a bounded blocking
  // FIFO so EVERY converted frame is processed in order; a full queue
  // backpressures the converter (which sheds at its own latest-wins camera
  // input). 8 = a few frames of slack without unbounded memory growth.
  static constexpr size_t kFifoCapacity = 8;

  // INTRINSIC variant. Maps built SYNCHRONOUSLY here (attach, NAPI thread —
  // tens of ms once per session-open), owned by the stream
  // (2× CV_32FC1 sensor-size Mats), freed with the stream.
  static Ptr create(Source source, std::string sourceId,
                    const CameraCalibration::Ptr &cal, std::string name) {
    return std::make_shared<UndistortStream>(std::move(source),
                                             std::move(sourceId), cal,
                                             std::move(name));
  }
  UndistortStream(Source source, std::string sourceId,
                  const CameraCalibration::Ptr &cal, std::string name)
      : ChainedStream(std::move(source), ChannelKind::fifo(kFifoCapacity)),
        variant_(Variant::Intrinsic), name_(name),
        sourceId_(std::move(sourceId)),
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
      : ChainedStream(std::move(source), ChannelKind::fifo(kFifoCapacity)),
        variant_(Variant::Homography), name_(name),
        sourceId_(std::move(sourceId)), ring_(ringCapacity),
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
  // The owning camera's serial (resolved at attach — from the legacy Camera
  // argument or the source converter's camera edge). Read by the probe's
  // `calibratedClock`; NAPI-thread only (set before the binding registers).
  void setCameraSerial(std::string serial) { serial_ = std::move(serial); }
  const std::string &cameraSerial() const { return serial_; }

  // --- probes ---------------------------------------------------------------
  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  Variant variant() const { return variant_; }
  const char *variantName() const {
    return variant_ == Variant::Intrinsic ? "intrinsic" : "homography";
  }
  // The CAMERA's calibration state (owner-applied dt — explicit
  // `calibrateClock` succeeded for this serial). False until then: frames
  // carry the raw counter and the ring lookup runs uncalibrated.
  bool calibratedClock() const { return isClockCalibrated(serial_); }
  // Frames passed through untouched (homography variant with an empty ring).
  uint64_t passthroughCount() const {
    return passthrough_.load(std::memory_order_relaxed);
  }
  const std::string &name() const { return name_; }
  const std::string &sourceId() const { return sourceId_; }
  // Test hook (mirrors KcfTrackerStream::stall): add `ms` of artificial
  // per-frame work so the converter outruns this brick, filling the input FIFO
  // and exercising the backpressure + high-water metering. NAPI-thread writer.
  void stall(double ms) { stallMs_.store(ms, std::memory_order_release); }

protected:
  void stop() override {
    ChainedStream::stop();
    // Parked (stream thread — single-writer over buf_): drop the reused
    // full-frame output. map1_/map2_ are deliberately KEPT:
    // initUndistortRectifyMap at sensor size is an expensive rebuild, not worth
    // the park-time savings.
    buf_.release();
  }

  // FIFO metering (single-writer rule preserved — this brick's own thread):
  // the peak input-queue occupancy since the last dequeue + the FIFO capacity,
  // per-bin MAX over the meter's 10s/1s window. Surfaced as `queue:{depth,
  // highWater, capacity}` by `meterSnapshotToJs`.
  void onQueueSample(uint32_t highWater, uint32_t capacity) override {
    meter_.queueDepth(highWater, capacity, converterNowMs());
  }

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
      // OWNER-APPLIED timestamps: deviceTimestamp is already calibrated at
      // Frame creation (Camera dt) — use it DIRECTLY.
      const int64_t hostNs = static_cast<int64_t>(in->deviceTimestamp);
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
    if (const double s = stallMs_.load(std::memory_order_acquire); s > 0)
      std::this_thread::sleep_for(
          std::chrono::duration<double, std::milli>(s));
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
  std::string serial_;         // owning camera (probe: calibratedClock)
  std::atomic<uint64_t> passthrough_{0};
  std::atomic<double> stallMs_{0}; // test-only induced slowness
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat buf_;              // reused output buffer (this thread only)
};

// Cross-brick lookup (FoveaStream attach by undistort pipeId): the live
// undistort brick bound to `pipeId`, or nullptr. Defined in
// UndistortStream.cpp (owns the registry); NAPI-thread only.
UndistortStream::Ptr findUndistort(const std::string &pipeId);

} // namespace Arv
