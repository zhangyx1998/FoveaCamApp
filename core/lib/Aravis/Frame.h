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
  // Unpack GenICam 12p packed data (PFNC): two 12-bit pixels per 3 bytes into a
  // CV_16UC1 buffer. Layout: b0 = P0[7:0]; b1 = (P1[3:0] << 4) | P0[11:8];
  // b2 = P1[11:4]. Values are right-justified (0..4095), not left-shifted.
  static inline void unpack12p(const uint8_t *src, uint16_t *dst,
                               size_t count) {
    const size_t pairs = count / 2;
    size_t s = 0;
    for (size_t i = 0; i < pairs; ++i, s += 3) {
      const uint8_t b0 = src[s], b1 = src[s + 1], b2 = src[s + 2];
      dst[2 * i] = static_cast<uint16_t>(b0 | ((b1 & 0x0F) << 8));
      dst[2 * i + 1] = static_cast<uint16_t>((b1 >> 4) | (b2 << 4));
    }
    // Odd trailing pixel (uncommon — sensor widths are typically even)
    if (count & 1) {
      const uint8_t b0 = src[s], b1 = src[s + 1];
      dst[count - 1] = static_cast<uint16_t>(b0 | ((b1 & 0x0F) << 8));
    }
  }

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
      const size_t expected = (count * 3 + 1) / 2;
      if (src_size < expected)
        throw std::runtime_error(
            "Packed 12p buffer too small: got " + std::to_string(src_size) +
            " bytes, expected " + std::to_string(expected));
      unpack12p(static_cast<const uint8_t *>(data),
                reinterpret_cast<uint16_t *>(mat.data), count);
    } else {
      const size_t dst_size = mat.size().area() * mat.elemSize();
      // Copy data from buffer to Mat
      std::memcpy(mat.data, data, std::min(src_size, dst_size));
    }
    return mat;
  }

public:
  // Private constructor - only accessible via Shared::create()
  inline Frame(ArvBuffer *buffer)
      : raw(fromArvBuffer(buffer)), format(getPixelFormat(buffer)),
        timestamp(arv_buffer_get_timestamp(buffer)) {};

  const cv::Mat raw;
  const PixelFormat format;
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

} // namespace Arv
