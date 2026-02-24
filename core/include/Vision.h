// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "pointer.h"
#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>
#include <opencv2/core/mat.hpp>
#include <opencv2/imgproc.hpp>
#include <vector>

//! type of the robust estimation algorithm
typedef enum EstimationMethod {
  LMEDS = cv::LMEDS,                 //!< least-median of squares algorithm
  RANSAC = cv::RANSAC,               //!< RANSAC algorithm
  RHO = cv::RHO,                     //!< RHO algorithm
  USAC_DEFAULT = cv::USAC_DEFAULT,   //!< USAC algorithm, default settings
  USAC_PARALLEL = cv::USAC_PARALLEL, //!< USAC, parallel version
  USAC_FM_8PTS = cv::USAC_FM_8PTS,   //!< USAC, fundamental matrix 8 points
  USAC_FAST = cv::USAC_FAST,         //!< USAC, fast settings
  USAC_ACCURATE = cv::USAC_ACCURATE, //!< USAC, accurate settings
  USAC_PROSAC = cv::USAC_PROSAC,     //!< USAC, sorted points, runs PROSAC
  USAC_MAGSAC = cv::USAC_MAGSAC      //!< USAC, runs MAGSAC++
} EstimationMethod;

typedef struct CameraCalibration : public Shared<CameraCalibration> {
  cv::Size2i sensor_size;
  cv::Mat camera_matrix, dist_coeffs;
  std::vector<cv::Mat> rvecs, tvecs;
} CameraCalibration;

typedef enum CvtColorCode {
  BGR2BGRA = cv::COLOR_BGR2BGRA,
  RGB2RGBA = cv::COLOR_RGB2RGBA,

  BGRA2BGR = cv::COLOR_BGRA2BGR,
  RGBA2RGB = cv::COLOR_RGBA2RGB,

  BGR2RGBA = cv::COLOR_BGR2RGBA,
  RGB2BGRA = cv::COLOR_RGB2BGRA,

  RGBA2BGR = cv::COLOR_RGBA2BGR,
  BGRA2RGB = cv::COLOR_BGRA2RGB,

  BGR2RGB = cv::COLOR_BGR2RGB,
  RGB2BGR = cv::COLOR_RGB2BGR,

  BGRA2RGBA = cv::COLOR_BGRA2RGBA,
  RGBA2BGRA = cv::COLOR_RGBA2BGRA,

  BGR2GRAY = cv::COLOR_BGR2GRAY,
  RGB2GRAY = cv::COLOR_RGB2GRAY,
  GRAY2BGR = cv::COLOR_GRAY2BGR,
  GRAY2RGB = cv::COLOR_GRAY2RGB,
  GRAY2BGRA = cv::COLOR_GRAY2BGRA,
  GRAY2RGBA = cv::COLOR_GRAY2RGBA,
  BGRA2GRAY = cv::COLOR_BGRA2GRAY,
  RGBA2GRAY = cv::COLOR_RGBA2GRAY,

  BayerBG2BGR = cv::COLOR_BayerBG2BGR,
  BayerGB2BGR = cv::COLOR_BayerGB2BGR,
  BayerRG2BGR = cv::COLOR_BayerRG2BGR,
  BayerGR2BGR = cv::COLOR_BayerGR2BGR,

  BayerRGGB2BGR = cv::COLOR_BayerRGGB2BGR,
  BayerGRBG2BGR = cv::COLOR_BayerGRBG2BGR,
  BayerBGGR2BGR = cv::COLOR_BayerBGGR2BGR,
  BayerGBRG2BGR = cv::COLOR_BayerGBRG2BGR,

  BayerRGGB2RGB = cv::COLOR_BayerRGGB2RGB,
  BayerGRBG2RGB = cv::COLOR_BayerGRBG2RGB,
  BayerBGGR2RGB = cv::COLOR_BayerBGGR2RGB,
  BayerGBRG2RGB = cv::COLOR_BayerGBRG2RGB,

  BayerBG2RGB = cv::COLOR_BayerBG2RGB,
  BayerGB2RGB = cv::COLOR_BayerGB2RGB,
  BayerRG2RGB = cv::COLOR_BayerRG2RGB,
  BayerGR2RGB = cv::COLOR_BayerGR2RGB,

  BayerBG2GRAY = cv::COLOR_BayerBG2GRAY,
  BayerGB2GRAY = cv::COLOR_BayerGB2GRAY,
  BayerRG2GRAY = cv::COLOR_BayerRG2GRAY,
  BayerGR2GRAY = cv::COLOR_BayerGR2GRAY,

  BayerRGGB2GRAY = cv::COLOR_BayerRGGB2GRAY,
  BayerGRBG2GRAY = cv::COLOR_BayerGRBG2GRAY,
  BayerBGGR2GRAY = cv::COLOR_BayerBGGR2GRAY,
  BayerGBRG2GRAY = cv::COLOR_BayerGBRG2GRAY,
} CvtColorCode;
