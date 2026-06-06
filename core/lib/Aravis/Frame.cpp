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
  auto ref = conversions.ref();
  if (ref->has(format))
    return ref->at(format);
  try {
    cv::Mat converted;
    cv::cvtColor(raw, converted, cvtColorCode(this->format, format));
    // When demosaicing/converting a >8-bit container (Mono16/Bayer16/12p) into
    // an 8-bit target format, OpenCV preserves the 16-bit depth. Scale down to
    // true 8-bit using the source's significant bit depth so 12-bit data isn't
    // rendered ~16x too dark (and so view(PixelFormat8) honors its Uint8 type).
    const int dstDepth = CV_MAT_DEPTH(convert<cv::Format>(format));
    if (dstDepth == CV_8U && converted.depth() != CV_8U) {
      const double maxVal = (1 << significantBits(this->format)) - 1;
      converted.convertTo(converted,
                          CV_MAKETYPE(CV_8U, converted.channels()),
                          255.0 / maxVal);
    }
    ref->insert({format, std::move(converted)});
    return ref->at(format);
  } catch (const UnknownPixelFormat &e) {
    throw std::runtime_error("Unsupported pixel format conversion from " +
                             convert<std::string>(this->format) + " to " +
                             convert<std::string>(format));
  }
}

} // namespace Arv
