// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// WS1 real-1g (B-23): the per-(camera × format) UNDISTORT producer thread.
// Mirrors the real-1e ConverterStream: one dedicated thread pulls the LATEST
// camera frame (Sub::Latest, latest-wins), runs the SHARED `convertFrame`
// (raw→target pixelFormat, incl. the >8-bit down-scale) THEN `cv::remap` with
// maps PRECOMPUTED at attach (`cv::initUndistortRectifyMap` from the persisted
// CameraCalibration JSON — same math as Vision.cpp's env-bound `Undistort`,
// which must never cross to this thread). ONE thread does convert+remap by
// design: chaining off a ConverterStream would be contract-UNSAFE — the
// downstream TransformStream's built-in Sub::Latest retains the ConvertedFrame
// Ptr past its reused-buffer validity window (B-23 ruling). Convert→remap
// order is v1-correct for all sources (per-pixel format ops commute with the
// geometric remap; Bayer-safe because conversion demosaics/grays first);
// remap-first-on-Mono is a metered follow-up only.
//
// Products are `ConvertedFrame`s under the SAME reused-buffer contract as
// ConverterStream (valid only during synchronous dispatch); the pipe producer
// is the shared gated `PipeOfferSubscriber`.

#include <opencv2/opencv.hpp>

#include <Vision.h> // CameraCalibration

#include "ConverterStream.h" // ConvertedFrame, PipeOfferSubscriber, converterNowMs

namespace Arv {

class UndistortStream
    : public TransformStream<Frame::Ptr, ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<UndistortStream>;
  static Ptr create(Arv::Stream::Ptr upstream, PixelFormat target,
                    const CameraCalibration::Ptr &cal) {
    return std::make_shared<UndistortStream>(std::move(upstream), target, cal);
  }
  // Maps are built SYNCHRONOUSLY here (i.e. at attach, on the NAPI thread —
  // tens of ms once per session-open, B-23 ruling #4) and owned by the stream
  // (2× CV_32FC1 sensor-size Mats), freed on detach with the stream.
  UndistortStream(Arv::Stream::Ptr upstream, PixelFormat target,
                  const CameraCalibration::Ptr &cal)
      : upstream_(std::move(upstream)), target_(target),
        meter_("undistort:" + convert<std::string>(target), {"frame"},
               {"undistorted"}, converterNowMs()) {
    const auto &mtx = cal->camera_matrix;
    const auto &dist = cal->dist_coeffs;
    cv::initUndistortRectifyMap(mtx, dist, {}, mtx, cal->sensor_size,
                                CV_32FC1, map1_, map2_);
  }
  ~UndistortStream() override { shutdown(); }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  PixelFormat target() const { return target_; }

protected:
  Stream<Frame::Ptr> *upstream() override { return upstream_.get(); }

  ConvertedFrame::Ptr transform(const Frame::Ptr &frame) override {
    const int64_t t = converterNowMs();
    const uint64_t d = upstreamDrops();
    if (d > lastDrops_) { // camera outran convert+remap (latest-wins overwrote)
      meter_.drop(d - lastDrops_);
      lastDrops_ = d;
    }
    meter_.ingest("frame", t);

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    convertFrame(frame->raw, frame->format, target_, tmp_);
    // Geometry guard: the maps are sensor-size; a frame of any other geometry
    // (ROI/binning change ⇒ A re-advertises + re-attaches) must be dropped
    // here — remap would blindly emit map-sized output sampled off-grid.
    if (tmp_.size() != map1_.size()) {
      meter_.end(converterNowMs());
      return nullptr; // base loop + PipeOfferSubscriber both tolerate null
    }
    cv::remap(tmp_, buf_, map1_, map2_, cv::INTER_LINEAR);
    const double processMs =
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - c0)
            .count();
    meter_.end(converterNowMs());

    auto cf = ConvertedFrame::create();
    cf->mat = buf_; // header over the reused buffer (ConvertedFrame contract)
    cf->deviceTimestamp = frame->device_timestamp;
    cf->systemTimestamp = frame->system_timestamp;
    cf->convertMs = processMs; // total convert+remap ms (documented semantics)
    meter_.emit("undistorted", converterNowMs());
    return cf;
  }

private:
  Arv::Stream::Ptr upstream_;
  const PixelFormat target_;
  Meter::ThreadMeter meter_; // single writer = this transform thread
  cv::Mat map1_, map2_;      // precomputed at attach; read-only on the thread
  cv::Mat tmp_;              // reused convert target (transform thread only)
  cv::Mat buf_;              // reused remap target (transform thread only)
  uint64_t lastDrops_ = 0;   // transform-thread only
};

} // namespace Arv
