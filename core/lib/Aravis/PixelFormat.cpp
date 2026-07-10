// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <convert.h>

#include "PixelFormat.h"

using namespace Arv;

// All five 19-entry conversion tables below expand the single source registry
// (docs/schema/pixel-formats.ts → PixelFormat.gen.h): Aravis↔internal,
// string↔internal, and internal→cv::Format. Adding a format = editing that
// table + regenerating; no switch here changes.
template <>
PixelFormat convert(const ArvPixelFormat &fmt) {
  switch (fmt) {
#define FOVEA_PF_FROM_ARV(Name, Arv, Cv, Bits, Packed)                        \
  case Arv:                                                                    \
    return Name;
    FOVEA_PIXEL_FORMATS(FOVEA_PF_FROM_ARV)
#undef FOVEA_PF_FROM_ARV
  default:
    auto name = arv_pixel_format_to_gst_caps_string(fmt);
    throw UnknownPixelFormat(name ? name : "(unknown)");
  }
}

PixelFormat Arv::getPixelFormat(ArvBuffer *buffer) {
  auto fmt = arv_buffer_get_image_pixel_format(buffer);
  return convert<PixelFormat>(fmt);
}

template <> PixelFormat convert(const std::string &fmt) {
#define FOVEA_PF_FROM_STR(Name, Arv, Cv, Bits, Packed)                        \
  if (fmt == #Name)                                                            \
    return Name;
  FOVEA_PIXEL_FORMATS(FOVEA_PF_FROM_STR)
#undef FOVEA_PF_FROM_STR
  throw UnknownPixelFormat(fmt);
}

template <> std::string convert(const PixelFormat &fmt) {
  switch (fmt) {
#define FOVEA_PF_TO_STR(Name, Arv, Cv, Bits, Packed)                          \
  case Name:                                                                   \
    return #Name;
    FOVEA_PIXEL_FORMATS(FOVEA_PF_TO_STR)
#undef FOVEA_PF_TO_STR
  }
  throw UnknownPixelFormat(std::to_string(fmt));
}

// 12p packed formats are unpacked into a 16-bit single-channel container.
template <> cv::Format convert(const PixelFormat &fmt) {
  switch (fmt) {
#define FOVEA_PF_TO_CV(Name, Arv, Cv, Bits, Packed)                           \
  case Name:                                                                   \
    return cv::Format::Cv;
    FOVEA_PIXEL_FORMATS(FOVEA_PF_TO_CV)
#undef FOVEA_PF_TO_CV
  }
  throw UnknownPixelFormat(std::to_string(fmt));
}

template <> ArvPixelFormat convert(const PixelFormat &fmt) {
  switch (fmt) {
#define FOVEA_PF_TO_ARV(Name, Arv, Cv, Bits, Packed)                          \
  case Name:                                                                   \
    return Arv;
    FOVEA_PIXEL_FORMATS(FOVEA_PF_TO_ARV)
#undef FOVEA_PF_TO_ARV
  }
  throw UnknownPixelFormat(std::to_string(fmt));
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
  case Mono12p:
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
  // Bayer families: the OpenCV demosaic constant carries the OpenCV↔PFNC
  // off-by-one R/B-swap correction (channel-order-fix.md) — e.g. a GenICam
  // BayerRG (RGGB) sensor demosaics with cv::COLOR_BayerBG2*, NOT BayerRG2*.
  // The cv prefix is GENERATED from the shared registry (FOVEA_BAYER_CV_FORMATS,
  // docs/schema/pixel-formats.ts) so this table can't drift from the viewer /
  // capture JS mirrors. Greens are unchanged — a PURE R/B swap, NO demosaic
  // phase shift. 16/12p reuse their 8-bit family's demosaic.
#define FOVEA_BAYER_CVT(SrcFmt, CvPfx)                                         \
  case SrcFmt:                                                                 \
    switch (dst) {                                                             \
    case RGB8:                                                                 \
      return cv::COLOR_##CvPfx##2RGB;                                          \
    case BGR8:                                                                 \
      return cv::COLOR_##CvPfx##2BGR;                                          \
    case RGBA8:                                                                \
      return cv::COLOR_##CvPfx##2RGBA;                                         \
    case BGRA8:                                                                \
      return cv::COLOR_##CvPfx##2BGRA;                                         \
    case Mono8:                                                                \
    case Mono16:                                                               \
      return cv::COLOR_##CvPfx##2GRAY;                                         \
      DEFAULT;                                                                 \
    }
    FOVEA_BAYER_CV_FORMATS(FOVEA_BAYER_CVT)
#undef FOVEA_BAYER_CVT
    DEFAULT;
  }
}
#undef CASE
#undef DEFAULT
