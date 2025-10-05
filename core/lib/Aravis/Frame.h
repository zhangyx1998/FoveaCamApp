// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include <cstddef>
#include <cstring>
#include <mutex>
#include <opencv2/imgproc.hpp>
#include <sys/types.h>

#include <arv.h>
#include <opencv2/opencv.hpp>

#include "PixelFormat.h"
#include <utils/map-set.h>
#include <utils/pointer.h>

namespace Arv {

class Frame : public Shared<Frame> {
  static inline const cv::Mat fromArvBuffer(ArvBuffer *buffer) {
    if (buffer == nullptr)
      throw std::runtime_error("ArvBuffer is null");
    if (arv_buffer_get_status(buffer) != ARV_BUFFER_STATUS_SUCCESS)
      throw std::runtime_error("Bad ArvBuffer status");
    // Get source buffer information
    size_t src_size;
    const void *data = arv_buffer_get_data(buffer, &src_size);
    const auto format = getPixelFormat(buffer);
    // Create OpenCV Mat from buffer data
    // Note: We create a copy of the data to ensure memory safety
    cv::Mat mat(arv_buffer_get_image_height(buffer),
                arv_buffer_get_image_width(buffer),
                convert<cv::Format>(format));
    const size_t dst_size = mat.size().area() * mat.elemSize();
    // Copy data from buffer to Mat
    std::memcpy(mat.data, data, std::min(src_size, dst_size));
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

  std::mutex conversion_mutex;
  Map<PixelFormat, const cv::Mat> conversions;

  inline std::string tag() const {
    return std::to_string(width()) + "×" + std::to_string(height()) + " " +
           convert<std::string>(format) + " @ " + std::to_string(timestamp);
  }
  inline size_t width() const { return raw.cols; };
  inline size_t height() const { return raw.rows; };
  const cv::Mat &view(PixelFormat format);
  inline const cv::Mat &view(const std::string &format) {
    return view(convert<PixelFormat>(format));
  };
  // Quick check if conversion requires computation
  inline bool isCached(PixelFormat format) {
    std::scoped_lock lock(conversion_mutex);
    return this->format == format || conversions.contains(format);
  }
  inline bool isCached(const std::string &format) {
    return isCached(convert<PixelFormat>(format));
  }
};

} // namespace Arv
