// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "pointer.h"
#include <opencv2/core.hpp>
#include <opencv2/core/mat.hpp>
#include <vector>

typedef struct CameraCalibration : public Shared<CameraCalibration> {
  cv::Size2i sensor_size;
  cv::Mat camera_matrix, dist_coeffs;
  std::vector<cv::Mat> rvecs, tvecs;
} CameraCalibration;
