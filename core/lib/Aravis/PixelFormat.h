#pragma once

#include <string>

#include <arv.h>
#include <opencv2/opencv.hpp>

#include <convert.h>

namespace cv {

typedef enum Format : int {
  U8C1 = CV_8UC1,
  U8C2 = CV_8UC2,
  U8C3 = CV_8UC3,
  U8C4 = CV_8UC4,
  S8C1 = CV_8SC1,
  S8C2 = CV_8SC2,
  S8C3 = CV_8SC3,
  S8C4 = CV_8SC4,
  U16C1 = CV_16UC1,
  U16C2 = CV_16UC2,
  U16C3 = CV_16UC3,
  U16C4 = CV_16UC4,
  S16C1 = CV_16SC1,
  S16C2 = CV_16SC2,
  S16C3 = CV_16SC3,
  S16C4 = CV_16SC4,
  S32C1 = CV_32SC1,
  S32C2 = CV_32SC2,
  S32C3 = CV_32SC3,
  S32C4 = CV_32SC4,
  F32C1 = CV_32FC1,
  F32C2 = CV_32FC2,
  F32C3 = CV_32FC3,
  F32C4 = CV_32FC4,
  F64C1 = CV_64FC1,
  F64C2 = CV_64FC2,
  F64C3 = CV_64FC3,
  F64C4 = CV_64FC4,
  F16C1 = CV_16FC1,
  F16C2 = CV_16FC2,
  F16C3 = CV_16FC3,
  F16C4 = CV_16FC4,
} Format;

}

// PFNC value for Mono12p — not defined as a macro in this Aravis release,
// unlike the BayerXX12p variants. See GenICam PFNC spec.
#ifndef ARV_PIXEL_FORMAT_MONO_12P
#define ARV_PIXEL_FORMAT_MONO_12P ((ArvPixelFormat)0x010c0047)
#endif

namespace Arv {

class UnknownPixelFormat : public std::runtime_error {
public:
  inline UnknownPixelFormat(const std::string &fmt)
      : std::runtime_error("Unknown pixel format: " + fmt) {}
};

typedef enum PixelFormat : uint8_t {
  Mono8,
  Mono16,
  RGB8,
  BGR8,
  RGBA8,
  BGRA8,
  BayerGR8,
  BayerRG8,
  BayerGB8,
  BayerBG8,
  BayerGR16,
  BayerRG16,
  BayerGB16,
  // GenICam 12-bit packed (12p): 2 pixels in 3 bytes, unpacked to CV_16UC1.
  Mono12p,
  BayerGR12p,
  BayerRG12p,
  BayerGB12p,
  BayerBG12p,
} Format;

Format getPixelFormat(ArvBuffer *buffer);

cv::ColorConversionCodes cvtColorCode(PixelFormat src, PixelFormat dst);

// Significant bit depth of the pixel data. 12p data lives 0..4095 in a 16-bit
// container, so display scaling must use 4095 (not the container's 65535).
inline int significantBits(PixelFormat format) {
  switch (format) {
  case Mono12p:
  case BayerGR12p:
  case BayerRG12p:
  case BayerGB12p:
  case BayerBG12p:
    return 12;
  case Mono16:
  case BayerGR16:
  case BayerRG16:
  case BayerGB16:
    return 16;
  default:
    return 8;
  }
}

// True for GenICam 12p packed formats, which need bit-unpacking (not memcpy).
inline bool isPacked(PixelFormat format) {
  switch (format) {
  case Mono12p:
  case BayerGR12p:
  case BayerRG12p:
  case BayerGB12p:
  case BayerBG12p:
    return true;
  default:
    return false;
  }
}

} // namespace Arv

template <> Arv::PixelFormat convert(const std::string &fmt);
template <> std::string convert(const Arv::PixelFormat &fmt);
template <> cv::Format convert(const Arv::PixelFormat &fmt);
template <> ArvPixelFormat convert(const Arv::PixelFormat &fmt);
