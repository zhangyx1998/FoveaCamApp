// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "Frame.h"

namespace Arv {

void convertFrame(const cv::Mat &raw, PixelFormat src, PixelFormat dst,
                  cv::Mat &out) {
  if (src == dst) {
    raw.copyTo(out); // no conversion; still land in the caller's buffer
    return;
  }
  cv::cvtColor(raw, out, cvtColorCode(src, dst));
  // When demosaicing/converting a >8-bit container (Mono16/Bayer16/12p) into an
  // 8-bit target format, OpenCV preserves the 16-bit depth. Scale down to true
  // 8-bit using the source's significant bit depth so 12-bit data isn't
  // rendered ~16x too dark (and so an 8-bit target honors its Uint8 type — the
  // omission of this step caused the 12p "purple stripes" bug).
  const int dstDepth = CV_MAT_DEPTH(convert<cv::Format>(dst));
  if (dstDepth == CV_8U && out.depth() != CV_8U) {
    const double maxVal = (1 << significantBits(src)) - 1;
    out.convertTo(out, CV_MAKETYPE(CV_8U, out.channels()), 255.0 / maxVal);
  }
}

const cv::Mat &Frame::view(PixelFormat format) {
  if (this->format == format)
    return raw;
  auto ref = conversions.ref();
  if (ref->has(format))
    return ref->at(format);
  try {
    cv::Mat converted;
    convertFrame(raw, this->format, format, converted);
    ref->insert({format, std::move(converted)});
    return ref->at(format);
  } catch (const UnknownPixelFormat &e) {
    throw std::runtime_error("Unsupported pixel format conversion from " +
                             convert<std::string>(this->format) + " to " +
                             convert<std::string>(format));
  }
}

} // namespace Arv
