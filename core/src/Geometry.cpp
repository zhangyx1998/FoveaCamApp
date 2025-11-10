// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>
#include <opencv2/calib3d.hpp>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

#include <Aravis/Frame.h>
#include <Aravis/PixelFormat.h>
#include <Aravis/Stream.h>
#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <pointer.h>

#include "napi-helper.h"

using namespace Napi;
using namespace cv;
using std::vector;
using Points2D = vector<Point2d>;
using Points3D = vector<Point3d>;

static FN(identity) {
  const auto env = info.Env();
  try {
    auto n = convert<unsigned>(info[0]);
    cv::Mat identity = cv::Mat::eye(n, n, CV_64F);
    return convert(env, identity);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(transpose) {
  const auto env = info.Env();
  try {
    auto mat = convert<cv::Mat>(info[0]);
    cv::Mat transposed;
    cv::transpose(mat, transposed);
    return convert(env, transposed);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(matMul) {
  const auto env = info.Env();
  try {
    auto mat = convert<cv::Mat>(info[0]);
    for (size_t i = 1; i < info.Length(); ++i)
      mat *= convert<cv::Mat>(info[i]);
    return convert(env, mat);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(rotateX) {
  const auto env = info.Env();
  try {
    auto angle = convert<double>(info[0]);
    cv::Mat rot = cv::Mat::eye(4, 4, CV_64F);
    double c = std::cos(angle);
    double s = std::sin(angle);
    rot.at<double>(1, 1) = c;
    rot.at<double>(1, 2) = -s;
    rot.at<double>(2, 1) = s;
    rot.at<double>(2, 2) = c;
    return convert(env, rot);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(rotateY) {
  const auto env = info.Env();
  try {
    auto angle = convert<double>(info[0]);
    cv::Mat rot = cv::Mat::eye(4, 4, CV_64F);
    double c = std::cos(angle);
    double s = std::sin(angle);
    rot.at<double>(0, 0) = c;
    rot.at<double>(0, 2) = s;
    rot.at<double>(2, 0) = -s;
    rot.at<double>(2, 2) = c;
    return convert(env, rot);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(rotateZ) {
  const auto env = info.Env();
  try {
    auto angle = convert<double>(info[0]);
    cv::Mat rot = cv::Mat::eye(4, 4, CV_64F);
    double c = std::cos(angle);
    double s = std::sin(angle);
    rot.at<double>(0, 0) = c;
    rot.at<double>(0, 1) = -s;
    rot.at<double>(1, 0) = s;
    rot.at<double>(1, 1) = c;
    return convert(env, rot);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(translate) {
  const auto env = info.Env();
  try {
    auto p = convert<Point3d>(info[0]);
    cv::Mat trans = cv::Mat::eye(4, 4, CV_64F);
    trans.at<double>(0, 3) = p.x;
    trans.at<double>(1, 3) = p.y;
    trans.at<double>(2, 3) = p.z;
    return convert(env, trans);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(transform) {
  const auto env = info.Env();
  try {
    auto transform = convert<cv::Mat>(info[0]);
    auto points = convert<Points3D>(info[1]);
    // Verify transform matrix is 4x4 or 3x4
    if (transform.rows != 3 && transform.rows != 4)
      throw std::runtime_error("Transform matrix must have 3 or 4 rows");
    if (transform.cols != 4)
      throw std::runtime_error("Transform matrix must have 4 columns");
    if (points.empty())
      return Napi::Array::New(env); // Return empty array if no points
    // Convert all points to homogeneous coordinates matrix (4 x N)
    const auto n = points.size();
    cv::Mat homogeneous(transform.rows, n, CV_64F);
    if (transform.rows == 4) {
      // 4x4 transformation
      for (size_t i = 0; i < n; ++i) {
        homogeneous.at<double>(0, i) = points[i].x;
        homogeneous.at<double>(1, i) = points[i].y;
        homogeneous.at<double>(2, i) = points[i].z;
        homogeneous.at<double>(3, i) = 1.0;
      }
    } else {
      // 3x4 transformation
      for (size_t i = 0; i < n; ++i) {
        homogeneous.at<double>(0, i) = points[i].x;
        homogeneous.at<double>(1, i) = points[i].y;
        homogeneous.at<double>(2, i) = points[i].z;
      }
    }
    // Apply transformation in one shot: result = transform * homogeneous
    cv::Mat result = transform * homogeneous;
    // Convert result back to Point3D array
    Points3D transformed_points;
    transformed_points.reserve(n);
    if (transform.rows == 4) {
      // 4x4 transformation - apply perspective division
      for (size_t i = 0; i < n; ++i) {
        double w = result.at<double>(3, i);
        if (std::abs(w) < 1e-10) {
          throw std::runtime_error(
              "Division by zero in homogeneous coordinate");
        }
        transformed_points.push_back({result.at<double>(0, i) / w,
                                      result.at<double>(1, i) / w,
                                      result.at<double>(2, i) / w});
      }
    } else {
      // 3x4 transformation - no perspective division needed
      for (size_t i = 0; i < n; ++i) {
        transformed_points.push_back({result.at<double>(0, i),
                                      result.at<double>(1, i),
                                      result.at<double>(2, i)});
      }
    }
    return convert(env, transformed_points);
  }
  JS_EXCEPT(env.Undefined());
}

static FN(area) {
  const auto env = info.Env();
  try {
    auto contour = convert<Points2D>(info[0]);
    return convert(env, cv::contourArea(contour));
  }
  JS_EXCEPT(env.Undefined());
}

#define EXPORT_FUNCTION(F) exports.Set(#F, Napi::Function::New<F>(env, #F));

void exportGeometryModule(Napi::Env env, Napi::Object &exports) {
  EXPORT_FUNCTION(identity);
  EXPORT_FUNCTION(transpose);
  EXPORT_FUNCTION(matMul);
  EXPORT_FUNCTION(rotateX);
  EXPORT_FUNCTION(rotateY);
  EXPORT_FUNCTION(rotateZ);
  EXPORT_FUNCTION(translate);
  EXPORT_FUNCTION(transform);
  EXPORT_FUNCTION(area);
}
