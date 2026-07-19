// GENERATED from docs/schema/pixel-formats.ts by
// docs/schema/generate-pixel-formats.ts — DO NOT EDIT BY HAND.
// Edit the source table and rerun the generator, then commit both.
#pragma once

// X-macro registry: X(Name, ArvMacro, CvFormat, SignificantBits, IsPacked).
// GenICam 12p formats (IsPacked=true) carry 12 significant bits in a 16-bit
// container and unpack to CV_16UC1; display scaling uses 4095, not 65535.
#define FOVEA_PIXEL_FORMATS(X) \
  X(Mono8, ARV_PIXEL_FORMAT_MONO_8, U8C1, 8, false) \
  X(Mono16, ARV_PIXEL_FORMAT_MONO_16, U16C1, 16, false) \
  X(RGB8, ARV_PIXEL_FORMAT_RGB_8_PACKED, U8C3, 8, false) \
  X(BGR8, ARV_PIXEL_FORMAT_BGR_8_PACKED, U8C3, 8, false) \
  X(RGBA8, ARV_PIXEL_FORMAT_RGBA_8_PACKED, U8C4, 8, false) \
  X(BGRA8, ARV_PIXEL_FORMAT_BGRA_8_PACKED, U8C4, 8, false) \
  X(BayerGR8, ARV_PIXEL_FORMAT_BAYER_GR_8, U8C1, 8, false) \
  X(BayerRG8, ARV_PIXEL_FORMAT_BAYER_RG_8, U8C1, 8, false) \
  X(BayerGB8, ARV_PIXEL_FORMAT_BAYER_GB_8, U8C1, 8, false) \
  X(BayerBG8, ARV_PIXEL_FORMAT_BAYER_BG_8, U8C1, 8, false) \
  X(BayerGR16, ARV_PIXEL_FORMAT_BAYER_GR_16, U16C1, 16, false) \
  X(BayerRG16, ARV_PIXEL_FORMAT_BAYER_RG_16, U16C1, 16, false) \
  X(BayerGB16, ARV_PIXEL_FORMAT_BAYER_GB_16, U16C1, 16, false) \
  X(BayerBG16, ARV_PIXEL_FORMAT_BAYER_BG_16, U16C1, 16, false) \
  X(Mono12p, ARV_PIXEL_FORMAT_MONO_12P, U16C1, 12, true) \
  X(BayerGR12p, ARV_PIXEL_FORMAT_BAYER_GR_12P, U16C1, 12, true) \
  X(BayerRG12p, ARV_PIXEL_FORMAT_BAYER_RG_12P, U16C1, 12, true) \
  X(BayerGB12p, ARV_PIXEL_FORMAT_BAYER_GB_12P, U16C1, 12, true) \
  X(BayerBG12p, ARV_PIXEL_FORMAT_BAYER_BG_12P, U16C1, 12, true) \

// Bayer mosaic → OpenCV demosaic-constant prefix (cv::COLOR_<prefix>2*),
// carrying the OpenCV↔PFNC off-by-one R/B-swap correction. X(Name, CvPrefix).
#define FOVEA_BAYER_CV_FORMATS(X) \
  X(BayerGR8, BayerGB) \
  X(BayerRG8, BayerBG) \
  X(BayerGB8, BayerGR) \
  X(BayerBG8, BayerRG) \
  X(BayerGR16, BayerGB) \
  X(BayerRG16, BayerBG) \
  X(BayerGB16, BayerGR) \
  X(BayerBG16, BayerRG) \
  X(BayerGR12p, BayerGB) \
  X(BayerRG12p, BayerBG) \
  X(BayerGB12p, BayerGR) \
  X(BayerBG12p, BayerRG) \

