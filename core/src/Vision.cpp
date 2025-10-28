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

#include "Vision.h"
#include "napi-helper.h"

using namespace Napi;
using namespace cv;
using Corners = std::vector<Point2f>;
using Points3D = std::vector<Point3f>;

static inline std::string tag(const cv::Mat &mat) {
  return std::to_string(mat.cols) + "x" + std::to_string(mat.rows) + "x" +
         std::to_string(mat.channels()) + "@" +
         std::to_string(mat.elemSize1() * 8) + "bit";
}

static FN(findChessboardCorners) {
  auto env = info.Env();
  try {
    auto mat = convert<cv::Mat>(info[0]);
    const auto action = "findChessboardCorners(" + tag(mat) + ")";
    auto pattern_size = convert<cv::Size2i>(info[1]);
    VERBOSE("[Requested] %s", action.c_str());
    auto task = [mat, pattern_size, action]() {
      VERBOSE("[Dispatched] %s", action.c_str());
      Corners corners;
      cv::findChessboardCorners(mat, pattern_size, corners,
                                cv::CALIB_CB_ADAPTIVE_THRESH |
                                    cv::CALIB_CB_NORMALIZE_IMAGE);
      VERBOSE("[Completed] %s", action.c_str());
      return corners;
    };
    return OneShotWorker<Corners>::run(env, task);
  }
  JS_EXCEPT(env.Undefined())
}

static FN(cornerSubPix) {
  auto env = info.Env();
  try {
    const auto mat = convert<cv::Mat>(info[0]);
    auto corners = convert<Corners>(info[1]);
    const auto win_size = optionalArgument(info[2], cv::Size2i(9, 9));
    const auto zero_zone = optionalArgument(info[3], cv::Size2i(-1, -1));
    const auto criteria = optionalArgument<cv::TermCriteria>(
        info[4],
        {cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.01});
    const auto action = "cornerSubPix(" + tag(mat) + ")";
    VERBOSE("[Requested] %s", action.c_str());
    auto task = [mat, corners, win_size, zero_zone, criteria,
                 action]() mutable {
      VERBOSE("[Dispatched] %s", action.c_str());
      cv::cornerSubPix(mat, corners, win_size, zero_zone, criteria);
      VERBOSE("[Completed] %s", action.c_str());
      return corners;
    };
    return OneShotWorker<Corners>::run(env, task);
  }
  JS_EXCEPT(env.Undefined())
}

static FN(calibrateCamera) {
  auto env = info.Env();
  try {
    auto sensor_size = convert<cv::Size2i>(info[0]);
    auto img_points = convert<std::vector<Corners>>(info[1]);
    auto obj_points = convert<std::vector<Points3D>>(info[2]);
    auto criteria = optionalArgument<cv::TermCriteria>(
        info[3],
        {cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.01});
    const auto action = std::string{"calibrateCamera()"};
    VERBOSE("[Requested] %s", action.c_str());
    auto task = [env, sensor_size, img_points, obj_points, action]() {
      VERBOSE("[Dispatched] %s", action.c_str());
      auto ret = CameraCalibration::create();
      ret->sensor_size = sensor_size;
      cv::calibrateCamera(obj_points, img_points, sensor_size,
                          ret->camera_matrix, ret->dist_coeffs, ret->rvecs,
                          ret->tvecs);
      VERBOSE("[Completed] %s", action.c_str());
      return ret;
    };
    return OneShotWorker<CameraCalibration::Ptr>::run(env, task);
  }
  JS_EXCEPT(env.Undefined())
}

class Undistort : public Napi::ObjectWrap<Undistort> {
public:
  static void Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func =
        DefineClass(env, "Undistort",
                    {
                        INSTANCE_GETTER(Undistort, sensor_size),
                        INSTANCE_GETTER(Undistort, focal),
                        INSTANCE_GETTER(Undistort, center),
                        INSTANCE_GETTER(Undistort, fov),
                        INSTANCE_METHOD(Undistort, apply),
                        INSTANCE_METHOD(Undistort, undistortPoints),
                        INSTANCE_METHOD(Undistort, distortPoints),
                        INSTANCE_METHOD(Undistort, angular),
                        INSTANCE_METHOD(Undistort, position),
                    });
    exports.Set("Undistort", func);
  }
  Undistort(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<Undistort>(info) {
    auto env = info.Env();
    try {
      info.This().As<Napi::Object>().Set("calibration", info[0]);
      calibration = convert<CameraCalibration::Ptr>(info[0]);
      sensor_size = calibration->sensor_size;
      const auto &mtx = calibration->camera_matrix;
      const auto &dist = calibration->dist_coeffs;
      cv::initUndistortRectifyMap(mtx, dist, {}, mtx, sensor_size, CV_32FC1,
                                  map1, map2);
    }
    JS_EXCEPT()
  }

private:
  CameraCalibration::Ptr calibration;
  cv::Size2i sensor_size;
  cv::Mat map1, map2;

  inline Point2d focal() {
    const auto &mtx = calibration->camera_matrix;
    return Point2d(mtx.at<double>(0, 0), mtx.at<double>(1, 1));
  }

  inline Point2d center() {
    const auto &mtx = calibration->camera_matrix;
    return Point2d(mtx.at<double>(0, 2), mtx.at<double>(1, 2));
  }

  GET(sensor_size) {
    const auto env = info.Env();
    try {
      return convert(env, sensor_size);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(focal) {
    const auto env = info.Env();
    try {
      return convert(env, focal());
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(center) {
    const auto env = info.Env();
    try {
      return convert(env, center());
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(fov) {
    const auto env = info.Env();
    try {
      const auto f = focal(), c = center();
      const auto w = static_cast<double>(sensor_size.width);
      const auto h = static_cast<double>(sensor_size.height);
      const auto x1 = c.x / f.x, x2 = (w - c.x) / f.x;
      const auto y1 = c.y / f.y, y2 = (h - c.y) / f.y;
      const auto fov_x = abs(atan(x1)) + abs(atan(x2));
      const auto fov_y = abs(atan(y1)) + abs(atan(y2));
      return convert(env, Point2d{fov_x, fov_y});
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(apply) {
    auto env = info.Env();
    try {
      auto src = convert<cv::Mat>(info[0]);
      if (map1.empty() || map2.empty())
        throw JS::Error(env, "Undistort maps not initialized");
      cv::Mat dst;
      cv::remap(src, dst, map1, map2, cv::INTER_LINEAR);
      return convert(env, dst);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(undistortPoints) {
    const auto env = info.Env();
    try {
      // Get pixel position
      std::vector<Point2f> src;
      src.reserve(info.Length());
      for (size_t i = 0; i < info.Length(); ++i) {
        src.push_back(convert<Point2f>(info[i]));
      }
      std::vector<Point2f> dst;

      const auto &mtx = calibration->camera_matrix;
      const auto &dist = calibration->dist_coeffs;
      cv::undistortPoints(src, dst, mtx, dist, cv::noArray(), mtx);
      return convert(env, dst);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(distortPoints) {
    const auto env = info.Env();
    try {
      // Get undistorted pixel positions
      std::vector<Point2d> undistorted;
      undistorted.reserve(info.Length());
      for (size_t i = 0; i < info.Length(); ++i) {
        undistorted.push_back(convert<Point2d>(info[i]));
      }

      const auto &mtx = calibration->camera_matrix;
      const auto &dist = calibration->dist_coeffs;
      const auto f = focal(), c = center();

      // Convert undistorted 2D points to 3D points at z=1 plane
      std::vector<Point3d> obj_points;
      obj_points.reserve(undistorted.size());
      for (const auto &pt : undistorted) {
        const double x = (pt.x - c.x) / f.x;
        const double y = (pt.y - c.y) / f.y;
        obj_points.push_back(Point3d(x, y, 1.0));
      }

      // Project 3D points back to 2D with distortion
      std::vector<Point2d> distorted;
      const auto zeros = cv::Vec3d::zeros();
      cv::projectPoints(obj_points, zeros, zeros, mtx, dist, distorted);

      return convert(env, distorted);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(angular) {
    const auto env = info.Env();
    try {
      // Get pixel position
      std::vector<Point2d> src;
      src.reserve(info.Length());
      for (size_t i = 0; i < info.Length(); ++i)
        src.push_back(convert<Point2d>(info[i]));
      const auto f = focal(), c = center();
      std::vector<Point2d> angles;
      angles.reserve(src.size());
      for (const auto &p : src) {
        const auto x = (p.x - c.x) / f.x;
        const auto y = (p.y - c.y) / f.y;
        angles.push_back(Point2d(atan(x), atan(y)));
      }
      return convert(env, angles);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(position) {
    const auto env = info.Env();
    try {
      // Get angular position
      std::vector<Point2d> src;
      src.reserve(info.Length());
      for (size_t i = 0; i < info.Length(); ++i)
        src.push_back(convert<Point2d>(info[i]));
      // Convert to pixel position
      const auto f = focal(), c = center();
      std::vector<Point2d> pos;
      pos.reserve(src.size());
      for (const auto &p : src) {
        pos.push_back(Point2d(tan(p.x) * f.x + c.x, tan(p.y) * f.y + c.y));
      }
      return convert(env, pos);
    }
    JS_EXCEPT(env.Undefined())
  }
};

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportVisionNamespace(Napi::Env env, Napi::Object &exports) {
  Napi::Object vision = Napi::Object::New(env);
  EXPORT(vision, findChessboardCorners);
  EXPORT(vision, cornerSubPix);
  EXPORT(vision, calibrateCamera);
  Undistort::Init(env, vision);
  exports.Set("Vision", vision);
}
#undef EXPORT
