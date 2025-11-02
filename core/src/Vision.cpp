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

#include "AsyncTask.h"
#include "CoreObject.h"
#include "Vision.h"
#include "napi-helper.h"

using namespace Napi;
using namespace cv;
using std::string;
using std::to_string;
using std::vector;
using Points2D = vector<Point2f>;
using Points3D = vector<Point3f>;

static inline string tag(const cv::Mat &mat) {
  return to_string(mat.cols) + "x" + to_string(mat.rows) + "x" +
         to_string(mat.channels()) + "@" + to_string(mat.elemSize1() * 8) +
         "bit";
}

static FN(slice) {
  auto env = info.Env();
  try {
    auto mat = convert<cv::Mat>(info[0]);
    auto rect = convert<cv::Rect>(info[1]);
    if (rect.width <= 0 || rect.height <= 0)
      throw JS::Error(env, "Invalid slice size " + to_string(rect.width) + "x" +
                               to_string(rect.height));
    // Allow slice out of bounds, fill with zeros
    cv::Mat sliced = cv::Mat::zeros(rect.height, rect.width, mat.type());
    cv::Point tl(std::max(rect.x, 0), std::max(rect.y, 0));
    cv::Point br(std::min(rect.x + rect.width, mat.cols),
                 std::min(rect.y + rect.height, mat.rows));
    auto src = mat(cv::Rect(tl, br));
    cv::Point dst_tl(std::max(-rect.x, 0), std::max(-rect.y, 0));
    cv::Point dst_br(dst_tl.x + src.cols, dst_tl.y + src.rows);
    src.copyTo(sliced(cv::Rect(dst_tl, dst_br)));
    return convert(env, sliced);
  }
  JS_EXCEPT(env.Undefined())
}

static FN(findChessboardCorners) {
  auto env = info.Env();
  try {
    auto mat = convert<cv::Mat>(info[0]);
    auto pattern_size = convert<cv::Size2i>(info[1]);
    auto task = [mat, pattern_size] {
      Points2D corners;
      cv::findChessboardCorners(mat, pattern_size, corners,
                                cv::CALIB_CB_ADAPTIVE_THRESH |
                                    cv::CALIB_CB_NORMALIZE_IMAGE);
      return corners;
    };
    return AsyncTask<Points2D>::run(env, task,
                                    "findChessboardCorners(" + tag(mat) + ")");
  }
  JS_EXCEPT(env.Undefined())
}

static FN(cornerSubPix) {
  auto env = info.Env();
  try {
    const auto mat = convert<cv::Mat>(info[0]);
    auto corners = convert<Points2D>(info[1]);
    const auto win_size = optionalArgument(info[2], cv::Size2i(9, 9));
    const auto zero_zone = optionalArgument(info[3], cv::Size2i(-1, -1));
    const auto criteria = optionalArgument<cv::TermCriteria>(
        info[4],
        {cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.01});
    auto task = [mat, corners, win_size, zero_zone, criteria] {
      cv::cornerSubPix(mat, corners, win_size, zero_zone, criteria);
      return corners;
    };
    return AsyncTask<Points2D>::run(env, task,
                                    "cornerSubPix(" + tag(mat) + ")");
  }
  JS_EXCEPT(env.Undefined())
}

static FN(calibrateCamera) {
  auto env = info.Env();
  try {
    auto sensor_size = convert<cv::Size2i>(info[0]);
    auto img_points = convert<vector<Points2D>>(info[1]);
    auto obj_points = convert<vector<Points3D>>(info[2]);
    auto criteria = optionalArgument<cv::TermCriteria>(
        info[3],
        {cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 30, 0.01});
    auto task = [env, sensor_size, img_points, obj_points, criteria] {
      auto ret = CameraCalibration::create();
      ret->sensor_size = sensor_size;
      cv::calibrateCamera(obj_points, img_points, sensor_size,
                          ret->camera_matrix, ret->dist_coeffs, ret->rvecs,
                          ret->tvecs, 0, criteria);
      return ret;
    };
    return AsyncTask<CameraCalibration::Ptr>::run(env, task,
                                                  "calibrateCamera()");
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
                        INSTANCE_METHOD(Undistort, undistort),
                        INSTANCE_METHOD(Undistort, distort),
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

  // Perform undistort
  inline void __undistort__(Points2D &in, Points2D &out) {
    const auto &mtx = calibration->camera_matrix;
    const auto &dist = calibration->dist_coeffs;
    cv::undistortPoints(in, out, mtx, dist, cv::noArray(), mtx);
  }

  FN(undistort) {
    const auto env = info.Env();
    try {
      // Get pixel position
      auto points = convert<Points2D>(info[0]);
      __undistort__(points, points);
      return convert(env, points);
    }
    JS_EXCEPT(env.Undefined())
  }

  // Perform distort
  inline void __distort__(Points2D &in, Points2D &out) {
    const auto &mtx = calibration->camera_matrix;
    const auto &dist = calibration->dist_coeffs;
    const auto f = focal(), c = center();
    Points3D obj_points;
    obj_points.reserve(in.size());
    for (const auto &p : in) {
      const double x = (p.x - c.x) / f.x;
      const double y = (p.y - c.y) / f.y;
      obj_points.push_back(Point3f(x, y, 1.0));
    }
    // Project 3D points back to 2D with distortion
    const auto zeros = cv::Vec3d::zeros();
    cv::projectPoints(obj_points, zeros, zeros, mtx, dist, out);
  }

  FN(distort) {
    const auto env = info.Env();
    try {
      // Get undistorted pixel positions
      auto points = convert<Points2D>(info[0]);
      __distort__(points, points);
      return convert(env, points);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(angular) {
    const auto env = info.Env();
    try {
      // Get pixel position
      auto src = convert<Points2D>(info[0]);
      auto undistort = optionalArgument(info[1], false);
      if (undistort)
        __undistort__(src, src);
      const auto f = focal(), c = center();
      Points2D angles;
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
      auto ang = convert<Points2D>(info[0]);
      auto distort = optionalArgument(info[1], false);
      // Convert to pixel position
      const auto f = focal(), c = center();
      Points2D pos;
      pos.reserve(ang.size());
      for (const auto &a : ang) {
        pos.push_back(Point2d(tan(a.x) * f.x + c.x, tan(a.y) * f.y + c.y));
      }
      // Optional: apply distortion
      if (distort)
        __distort__(pos, pos);
      return convert(env, pos);
    }
    JS_EXCEPT(env.Undefined())
  }
};

typedef struct Projection : public Shared<Projection> {
  cv::Mat rvec, tvec, mtx, dist;
} Projection;

template <>
Napi ::Value convert(Napi ::Env env, const Projection::Ptr &core) noexcept;
template <>
Napi ::Value convert(Napi ::Env env, const Napi ::Value &container,
                     const Projection::Ptr &core) noexcept;
template <> Projection::Ptr convert(const Napi ::Value &value);

class Projector : public CoreObject<Projector, Projection::Ptr> {
  CORE_OBJECT_DECL(Projector);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "Projector";
  static Napi::Function Init(Napi::Env env) {
    auto fn = DefineClass(env, Projector::name.c_str(),
                          {
                              CORE_OBJECT_REGISTER(Projector, env),
                              INSTANCE_GETTER(Projector, rvec),
                              INSTANCE_GETTER(Projector, tvec),
                              INSTANCE_GETTER(Projector, mtx),
                              INSTANCE_GETTER(Projector, dist),
                              INSTANCE_METHOD(Projector, obj2img),
                              INSTANCE_METHOD(Projector, img2obj),
                          });
    fn.Set("solve", Function::New(env, solve, "solve"));
    return fn;
  }

private:
  GET(rvec) {
    try {
      return convert(env, core()->rvec);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(tvec) {
    try {
      return convert(env, core()->tvec);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(mtx) {
    try {
      return convert(env, core()->mtx);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(dist) {
    try {
      return convert(env, core()->dist);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(obj2img) {
    try {
      // Collect all 3D points to project
      auto obj_points = convert<Points3D>(info[0]);
      // Project points using stored rvec, tvec, mtx, dist
      Points2D img_points;
      cv::projectPoints(obj_points, core()->rvec, core()->tvec, core()->mtx,
                        core()->dist, img_points);
      return convert(env, img_points);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(img2obj) {
    try {
      // Collect all 2D image points to back-project
      auto img_points = convert<Points2D>(info[0]);
      const auto z_plane = optionalArgument(info[1], 0.0);
      // Undistort image points to normalized camera coordinates
      Points2D normalized_points;
      cv::undistortPoints(img_points, normalized_points, core()->mtx,
                          core()->dist);
      // Convert rotation vector to rotation matrix
      cv::Mat R;
      cv::Rodrigues(core()->rvec, R);
      // Get inverse rotation and translation
      cv::Mat R_inv = R.t(); // Transpose = inverse for rotation matrix
      cv::Mat t_inv = -R_inv * core()->tvec;
      // Back-project to 3D points at specified Z-plane in world coordinates
      Points3D obj_points;
      obj_points.reserve(normalized_points.size());
      for (const auto &pt : normalized_points) {
        // Ray direction in camera coordinates (normalized coordinates are
        // already dx/dz, dy/dz)
        cv::Mat ray_camera = (cv::Mat_<double>(3, 1) << pt.x, pt.y, 1.0);
        // Transform ray to world coordinates
        cv::Mat ray_world = R_inv * ray_camera;
        cv::Mat cam_origin_world = t_inv;
        // Find intersection with Z=z_plane
        // Point on ray: P = cam_origin + t * ray_direction
        // We want P.z = z_plane, so: cam_origin.z + t * ray_direction.z =
        // z_plane
        double t = (z_plane - cam_origin_world.at<double>(2)) /
                   ray_world.at<double>(2);
        double x = cam_origin_world.at<double>(0) + t * ray_world.at<double>(0);
        double y = cam_origin_world.at<double>(1) + t * ray_world.at<double>(1);

        obj_points.push_back(Point3f(x, y, z_plane));
      }
      return convert(env, obj_points);
    }
    JS_EXCEPT(env.Undefined())
  }

  static FN(solve) {
    auto env = info.Env();
    try {
      auto img_points = convert<Points2D>(info[0]);
      auto obj_points = convert<Points3D>(info[1]);
      // Optional calibration parameter - if not provided, use identity matrix
      auto calibration =
          optionalArgument<CameraCalibration::Ptr>(info[2], nullptr);
      auto projection = Projection::create();
      if (calibration) {
        projection->mtx = calibration->camera_matrix;
        projection->dist = calibration->dist_coeffs;
      } else {
        // Use identity matrix for camera matrix (normalized coordinates)
        projection->mtx = cv::Mat::eye(3, 3, CV_64F);
        projection->dist = cv::Mat(); // Empty distortion coefficients
      }
      const auto use_extrinsic_guess = optionalArgument(info[3], false);
      const auto method = optionalArgument(info[4], cv::SOLVEPNP_ITERATIVE);
      auto task = [img_points, obj_points, projection, use_extrinsic_guess,
                   method] {
        // Solve PnP to get rotation and translation vectors
        cv::solvePnP(obj_points, img_points, projection->mtx, projection->dist,
                     projection->rvec, projection->tvec, use_extrinsic_guess,
                     method);
        return projection;
      };
      return AsyncTask<Projection::Ptr>::run(env, task, "Projector.solve()");
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(Projector);

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportVisionNamespace(Napi::Env env, Napi::Object &exports) {
  Napi::Object vision = Napi::Object::New(env);
  EXPORT(vision, slice);
  EXPORT(vision, findChessboardCorners);
  EXPORT(vision, cornerSubPix);
  EXPORT(vision, calibrateCamera);
  Undistort::Init(env, vision);
  exportProjector(env, vision);
  exports.Set("Vision", vision);
}
#undef EXPORT
