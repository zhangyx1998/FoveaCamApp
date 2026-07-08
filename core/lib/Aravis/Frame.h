// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <cstddef>
#include <cstring>
#include <opencv2/imgproc.hpp>
#include <sys/types.h>

#include <arv.h>
#include <Codec/Packed12.h>
#include <opencv2/opencv.hpp>

#include <Threading/Guard.h>
#include <pointer.h>
#include <utils/map-set.h>

#include "PixelFormat.h"
namespace Arv {

#define CASE(S)                                                                \
  case ARV_BUFFER_STATUS_##S:                                                  \
    return #S;
inline std::string status(int status) {
  switch (status) {
    CASE(SUCCESS);
    CASE(CLEARED);
    CASE(TIMEOUT);
    CASE(MISSING_PACKETS);
    CASE(WRONG_PACKET_ID);
    CASE(SIZE_MISMATCH);
    CASE(FILLING);
    CASE(ABORTED);
    CASE(PAYLOAD_NOT_SUPPORTED);
  default:
    return "UNKNOWN";
  };
}
#undef CASE

class Frame : public Shared<Frame> {
  static inline const cv::Mat fromArvBuffer(ArvBuffer *buffer) {
    if (buffer == nullptr)
      throw std::runtime_error("ArvBuffer is null");
    if (arv_buffer_get_status(buffer) != ARV_BUFFER_STATUS_SUCCESS)
      throw std::runtime_error("Bad ArvBuffer status: " +
                               status(arv_buffer_get_status(buffer)));
    // Get source buffer information
    size_t src_size;
    const void *data = arv_buffer_get_data(buffer, &src_size);
    const auto format = getPixelFormat(buffer);
    // Create OpenCV Mat from buffer data
    // Note: We create a copy of the data to ensure memory safety
    cv::Mat mat(arv_buffer_get_image_height(buffer),
                arv_buffer_get_image_width(buffer),
                convert<cv::Format>(format));
    if (isPacked(format)) {
      // Packed 12p: 3 bytes per 2 pixels. Validate then bit-unpack.
      const size_t count = static_cast<size_t>(mat.cols) * mat.rows;
      const size_t expected = Codec::packed12Size(count);
      if (src_size < expected)
        throw std::runtime_error(
            "Packed 12p buffer too small: got " + std::to_string(src_size) +
            " bytes, expected " + std::to_string(expected));
      Codec::unpack12p(static_cast<const uint8_t *>(data),
                       reinterpret_cast<uint16_t *>(mat.data), count);
    } else {
      const size_t dst_size = mat.size().area() * mat.elemSize();
      // Copy data from buffer to Mat
      std::memcpy(mat.data, data, std::min(src_size, dst_size));
    }
    return mat;
  }

public:
  // Private constructor - only accessible via Shared::create().
  // `clockOffsetNs` = the OWNER-APPLIED device→host dt (Camera.h,
  // unified-time ruling 2026-07-08): Frame creation is the single choke point
  // where device timestamps enter the system, so every outward consumer (JS
  // Frame.deviceTimestamp, SHM slot headers, OwnedFrame taps, KCF results)
  // sees pre-calibrated time. 0 = uncalibrated passthrough (raw counter).
  inline Frame(ArvBuffer *buffer, int64_t clockOffsetNs = 0)
      : raw(fromArvBuffer(buffer)), format(getPixelFormat(buffer)),
        device_timestamp(static_cast<uint64_t>(
            static_cast<int64_t>(arv_buffer_get_timestamp(buffer)) +
            clockOffsetNs)),
        system_timestamp(arv_buffer_get_system_timestamp(buffer)),
        timestamp(device_timestamp) {};

  const cv::Mat raw;
  const PixelFormat format;
  // Device timestamp with the owning camera's calibrated clock offset ALREADY
  // applied (steadyNowNs host domain once calibrated; the raw device counter
  // while the offset is 0 — uncalibrated).
  const uint64_t device_timestamp;
  // Aravis system timestamp in the host clock domain, nanoseconds.
  const uint64_t system_timestamp;
  // Back-compat alias for device_timestamp.
  const uint64_t timestamp;
  const std::string tag =
      std::to_string(width()) + "×" + std::to_string(height()) + " " +
      convert<std::string>(format) + " @ " + std::to_string(timestamp);

  Threading::Guard<Map<PixelFormat, const cv::Mat>> conversions;

  inline size_t width() const { return raw.cols; };
  inline size_t height() const { return raw.rows; };
  const cv::Mat &view(PixelFormat format);
  inline const cv::Mat &view(const std::string &format) {
    return view(convert<PixelFormat>(format));
  };
  // Quick check if conversion requires computation
  inline bool isAvailable(PixelFormat format) {
    return this->format == format || conversions.ref()->contains(format);
  }
  inline bool isAvailable(const std::string &format) {
    return isAvailable(convert<PixelFormat>(format));
  }
};

// Single source of truth for the raw→display conversion (B-18). `cvtColor(raw,
// out, cvtColorCode(src,dst))` then, when `dst` is 8-bit but the cvtColor
// result kept a >8-bit container (Mono16 / Bayer16 / 12p → raw is CV_16UC1),
// scale to true 8-bit by the source's significant bit depth — the step whose
// omission in the old inline `feedPipe` caused the 12p "purple stripes" bug.
// `Frame::view` and the pipe converter thread both call this (no duplication).
// Writes into the caller's reusable `out` (src==dst is a plain copy).
void convertFrame(const cv::Mat &raw, PixelFormat src, PixelFormat dst,
                  cv::Mat &out);

} // namespace Arv
