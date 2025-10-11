// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <convert.h>

#include "PixelFormat.h"

using namespace Arv;

#define CASE(SRC, DST)                                                         \
  case SRC:                                                                    \
    return DST;
template <>
PixelFormat convert(const ArvPixelFormat &fmt) {
  switch (fmt) {
    CASE(ARV_PIXEL_FORMAT_MONO_8, Mono8);
    CASE(ARV_PIXEL_FORMAT_MONO_16, Mono16);
    CASE(ARV_PIXEL_FORMAT_RGB_8_PACKED, RGB8);
    CASE(ARV_PIXEL_FORMAT_BGR_8_PACKED, BGR8);
    CASE(ARV_PIXEL_FORMAT_RGBA_8_PACKED, RGBA8);
    CASE(ARV_PIXEL_FORMAT_BGRA_8_PACKED, BGRA8);
    CASE(ARV_PIXEL_FORMAT_BAYER_GR_8, BayerGR8);
    CASE(ARV_PIXEL_FORMAT_BAYER_RG_8, BayerRG8);
    CASE(ARV_PIXEL_FORMAT_BAYER_GB_8, BayerGB8);
    CASE(ARV_PIXEL_FORMAT_BAYER_BG_8, BayerBG8);
    CASE(ARV_PIXEL_FORMAT_BAYER_GR_16, BayerGR16);
    CASE(ARV_PIXEL_FORMAT_BAYER_RG_16, BayerRG16);
    CASE(ARV_PIXEL_FORMAT_BAYER_GB_16, BayerGB16);
  default:
    auto name = arv_pixel_format_to_gst_caps_string(fmt);
    throw UnknownPixelFormat(name ? name : "(unknown)");
  }
}
#undef CASE

PixelFormat Arv::getPixelFormat(ArvBuffer *buffer) {
  auto fmt = arv_buffer_get_image_pixel_format(buffer);
  return convert<PixelFormat>(fmt);
}

#define CASE(F)                                                                \
  if (fmt == #F)                                                               \
    return F;
template <> PixelFormat convert(const std::string &fmt) {
  CASE(Mono8);
  CASE(Mono16);
  CASE(RGB8);
  CASE(BGR8);
  CASE(RGBA8);
  CASE(BGRA8);
  CASE(BayerGR8);
  CASE(BayerRG8);
  CASE(BayerGB8);
  CASE(BayerBG8);
  CASE(BayerGR16);
  CASE(BayerRG16);
  CASE(BayerGB16);
  throw UnknownPixelFormat(fmt);
}
#undef CASE

#define CASE(F)                                                                \
  case F:                                                                      \
    return #F;
template <> std::string convert(const PixelFormat &fmt) {
  switch (fmt) {
    CASE(Mono8);
    CASE(Mono16);
    CASE(RGB8);
    CASE(BGR8);
    CASE(RGBA8);
    CASE(BGRA8);
    CASE(BayerGR8);
    CASE(BayerRG8);
    CASE(BayerGB8);
    CASE(BayerBG8);
    CASE(BayerGR16);
    CASE(BayerRG16);
    CASE(BayerGB16);
    throw UnknownPixelFormat(std::to_string(fmt));
  }
}
#undef CASE

template <> cv::Format convert(const PixelFormat &fmt) {
  switch (fmt) {
  case Mono8:
  case BayerGR8:
  case BayerRG8:
  case BayerGB8:
  case BayerBG8:
    return cv::Format::U8C1;
  case Mono16:
  case BayerGR16:
  case BayerRG16:
  case BayerGB16:
    return cv::Format::U16C1;
  case RGB8:
  case BGR8:
    return cv::Format::U8C3;
  case RGBA8:
  case BGRA8:
    return cv::Format::U8C4;
  default:
    throw UnknownPixelFormat(std::to_string(fmt));
  }
}

#define CASE(DST, CVT)                                                         \
  case DST:                                                                    \
    return cv::COLOR_##CVT;

#define DEFAULT                                                                \
  default:                                                                     \
    throw UnknownPixelFormat("Unsupported conversion");

cv::ColorConversionCodes Arv::cvtColorCode(PixelFormat src, PixelFormat dst) {
  switch (src) {
  case Mono8:
  case Mono16:
    switch (dst) {
      CASE(RGB8, GRAY2RGB);
      CASE(BGR8, GRAY2BGR);
      CASE(RGBA8, GRAY2RGBA);
      CASE(BGRA8, GRAY2BGRA);
      DEFAULT;
    }
  case RGB8:
    switch (dst) {
      CASE(BGR8, RGB2BGR);
      CASE(RGBA8, RGB2RGBA);
      CASE(BGRA8, RGB2BGRA);
      CASE(Mono8, RGB2GRAY);
      DEFAULT;
    }
  case BGR8:
    switch (dst) {
      CASE(RGB8, BGR2RGB);
      CASE(RGBA8, BGR2RGBA);
      CASE(BGRA8, BGR2BGRA);
      CASE(Mono8, BGR2GRAY);
      DEFAULT;
    }
  case RGBA8:
    switch (dst) {
      CASE(RGB8, RGBA2RGB);
      CASE(BGR8, RGBA2BGR);
      CASE(BGRA8, RGBA2BGRA);
      CASE(Mono8, RGBA2GRAY);
      DEFAULT;
    }
  case BGRA8:
    switch (dst) {
      CASE(RGB8, BGRA2RGB);
      CASE(BGR8, BGRA2BGR);
      CASE(RGBA8, BGRA2RGBA);
      CASE(Mono8, BGRA2GRAY);
      DEFAULT;
    }
  case BayerGR8:
    switch (dst) {
      CASE(RGB8, BayerGR2RGB);
      CASE(BGR8, BayerGR2BGR);
      CASE(RGBA8, BayerGR2RGBA);
      CASE(BGRA8, BayerGR2BGRA);
      DEFAULT;
    }
  case BayerRG8:
    switch (dst) {
      CASE(RGB8, BayerRG2RGB);
      CASE(BGR8, BayerRG2BGR);
      CASE(RGBA8, BayerRG2RGBA);
      CASE(BGRA8, BayerRG2BGRA);
      DEFAULT;
    }
  case BayerGB8:
    switch (dst) {
      CASE(RGB8, BayerGB2RGB);
      CASE(BGR8, BayerGB2BGR);
      CASE(RGBA8, BayerGB2RGBA);
      CASE(BGRA8, BayerGB2BGRA);
      DEFAULT;
    }
  case BayerBG8:
    switch (dst) {
      CASE(RGB8, BayerBG2RGB);
      CASE(BGR8, BayerBG2BGR);
      CASE(RGBA8, BayerBG2RGBA);
      CASE(BGRA8, BayerBG2BGRA);
      DEFAULT;
    }
  case BayerGR16:
    switch (dst) {
      CASE(RGB8, BayerGR2RGB);
      CASE(BGR8, BayerGR2BGR);
      CASE(RGBA8, BayerGR2RGBA);
      CASE(BGRA8, BayerGR2BGRA);
      DEFAULT;
    }
  case BayerRG16:
    switch (dst) {
      CASE(RGB8, BayerRG2RGB);
      CASE(BGR8, BayerRG2BGR);
      CASE(RGBA8, BayerRG2RGBA);
      CASE(BGRA8, BayerRG2BGRA);
      DEFAULT;
    }
  case BayerGB16:
    switch (dst) {
      CASE(RGB8, BayerGB2RGB);
      CASE(BGR8, BayerGB2BGR);
      CASE(RGBA8, BayerGB2RGBA);
      CASE(BGRA8, BayerGB2BGRA);
      DEFAULT;
    }
    DEFAULT;
  }
}
#undef CASE
#undef DEFAULT
