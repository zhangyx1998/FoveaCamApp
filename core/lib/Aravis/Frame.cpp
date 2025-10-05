// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "Frame.h"

namespace Arv {

const cv::Mat &Frame::view(PixelFormat format) {
  if (this->format == format)
    return raw;
  std::scoped_lock lock(conversion_mutex);
  if (conversions.has(format))
    return conversions.at(format);
  try {
    cv::Mat converted;
    cv::cvtColor(raw, converted, cvtColorCode(this->format, format));
    conversions.insert({format, std::move(converted)});
    return conversions.at(format);
  } catch (const UnknownPixelFormat &e) {
    throw std::runtime_error("Unsupported pixel format conversion from " +
                             convert<std::string>(this->format) + " to " +
                             convert<std::string>(format));
  }
}

} // namespace Arv
