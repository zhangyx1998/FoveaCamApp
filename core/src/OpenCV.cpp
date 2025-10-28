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

#include <Aravis/Frame.h>
#include <Aravis/PixelFormat.h>
#include <Aravis/Stream.h>
#include <opencv2/core/cvdef.h>
#include <opencv2/core/mat.hpp>
#include <opencv2/core/types.hpp>
#include <pointer.h>
#include <string>

#include "Vision.h"
#include "napi-helper.h"

#define CVT(TPL, EL, KX, KY, ...)                                              \
  template <> TPL<EL> convert(const Napi::Value &value) {                      \
    if (value.IsNumber()) {                                                    \
      const auto s = convert<EL>(value);                                       \
      return {s, s __VA_OPT__(, s)};                                           \
    }                                                                          \
    if (!value.IsObject())                                                     \
      throw JS::TypeError(value.Env(), "Argument must be an object");          \
    auto obj = value.As<Napi::Object>();                                       \
    return TPL<EL>(convert<EL>(obj.Get(#KX)),                                  \
                   convert<EL>(obj.Get(#KY))                                   \
                       __VA_OPT__(, convert<EL>(obj.Get(#__VA_ARGS__))));      \
  }                                                                            \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const Napi::Value &container,             \
                      const TPL<EL> &size) noexcept {                          \
    if (!container.IsObject())                                                 \
      JS_THROW(TypeError, "Container of " #TPL "<" #EL "> must be an object",  \
               container);                                                     \
    auto obj = container.As<Napi::Object>();                                   \
    obj.Set(#KX, convert(env, size.KX));                                       \
    obj.Set(#KY, convert(env, size.KY));                                       \
    __VA_OPT__(obj.Set(#__VA_ARGS__, convert(env, size.__VA_ARGS__));)         \
    return container;                                                          \
  }                                                                            \
                                                                               \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const TPL<EL> &size) noexcept {           \
    return convert(env, Napi::Object::New(env).As<Napi::Value>(), size);       \
  }                                                                            \
  /* 1D Vector */                                                              \
  CONVERT_ARRAY_OF(TPL<EL>);                                                   \
  /* 2D Vector */                                                              \
  CONVERT_ARRAY_OF(std::vector<TPL<EL>>);

CVT(cv::Size_, int, width, height)
CVT(cv::Size_, int64, width, height)
CVT(cv::Size_, float, width, height)
CVT(cv::Size_, double, width, height)

CVT(cv::Point_, int, x, y)
CVT(cv::Point_, int64, x, y)
CVT(cv::Point_, float, x, y)
CVT(cv::Point_, double, x, y)

CVT(cv::Point3_, int, x, y, z)
CVT(cv::Point3_, int64, x, y, z)
CVT(cv::Point3_, float, x, y, z)
CVT(cv::Point3_, double, x, y, z)

#define MATCH_MAT_TYPE_CASE(E, T, RET, SIZE, AB, OFFSET)                       \
  case E:                                                                      \
    RET = Napi::TypedArrayOf<T>::New(env, SIZE / sizeof(T), AB, OFFSET);       \
    break;

#define MATCH_MAT_TYPE(MAT, RET, SIZE, AB, OFFSET)                             \
  switch (CV_MAT_DEPTH(MAT.type())) {                                          \
    MATCH_MAT_TYPE_CASE(CV_8U, uint8_t, RET, SIZE, AB, OFFSET);                \
    MATCH_MAT_TYPE_CASE(CV_8S, int8_t, RET, SIZE, AB, OFFSET);                 \
    MATCH_MAT_TYPE_CASE(CV_16U, uint16_t, RET, SIZE, AB, OFFSET);              \
    MATCH_MAT_TYPE_CASE(CV_16S, int16_t, RET, SIZE, AB, OFFSET);               \
    MATCH_MAT_TYPE_CASE(CV_32S, int32_t, RET, SIZE, AB, OFFSET);               \
    MATCH_MAT_TYPE_CASE(CV_32F, float32_t, RET, SIZE, AB, OFFSET);             \
    MATCH_MAT_TYPE_CASE(CV_64F, float64_t, RET, SIZE, AB, OFFSET);             \
  default:                                                                     \
    JS_THROW(env,                                                              \
             "Unsupported Mat type " + std::to_string(MAT.type()) +            \
                 " (converting to TypedArray)",                                \
             env.Undefined());                                                 \
  }

template <> cv::MatSize convert(const Napi::Value &value) {
  throw JS::TypeError(value.Env(),
                      "Conversion from JS to cv::MatSize is not supported");
}

template <>
Napi::Value convert(Napi::Env env, const cv::MatSize &size) noexcept {
  std::vector<int> shape(size.dims());
  for (int i = 0; i < size.dims(); ++i)
    shape[i] = size[i];
  return convert(env, shape);
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::MatSize &size) noexcept {
  return convert(env, size);
}

template <> Napi::Value convert(Napi::Env env, const cv::Mat &mat) noexcept {
  const auto m = mat.isContinuous() ? mat : mat.clone();
  const auto size = m.size().area() * m.elemSize();
#ifdef V8_MEMORY_CAGE
  auto array_buffer = Napi::ArrayBuffer::New(env, size);
  std::memcpy(array_buffer.Data(), m.data, size);
#else
  // Increment reference count on ImagePtr holding the buffer pointer
  auto ref = new cv::Mat(m);
  // Return a borrowed ArrayBuffer pointing to external Mat data
  auto array_buffer =
      Napi::ArrayBuffer::New(env, ref->data, size, deleter<cv::Mat>, ref);
#endif
  Napi::Object ret;
  MATCH_MAT_TYPE(m, ret, size, array_buffer, 0);
  ret.Set("shape", convert(env, m.size));
  ret.Set("channels", convert(env, m.channels()));
  return ret;
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::Mat &mat) noexcept {
  const auto m = mat.isContinuous() ? mat : mat.clone();
  if (isBufferLike(container)) {
    const auto size = mat.size().area() * mat.elemSize();
    auto view = bufferView(container);
    if (view.size == size) {
      // Mutate data in place
      view.copyFrom(m.data, size);
      // Unwrap underlying ArrayBuffer and re-wrap with correct shape/channels
      Napi::ArrayBuffer array_buffer;
      size_t byte_offset = 0;
      if (container.IsArrayBuffer()) {
        array_buffer = container.As<Napi::ArrayBuffer>();
      } else if (container.IsTypedArray()) {
        array_buffer = container.As<Napi::TypedArray>().ArrayBuffer();
        byte_offset = container.As<Napi::TypedArray>().ByteOffset();
      } else if (container.IsDataView()) {
        array_buffer = container.As<Napi::DataView>().ArrayBuffer();
        byte_offset = container.As<Napi::DataView>().ByteOffset();
      } else {
        JS_THROW(TypeError,
                 "Container of Mat must be ArrayBuffer, TypedArray or DataView",
                 env.Null());
      }
      Napi::Object ret;
      MATCH_MAT_TYPE(m, ret, size, array_buffer, byte_offset);
      ret.As<Napi::Object>().Set("shape", convert(env, m.size));
      ret.As<Napi::Object>().Set("channels", convert(env, m.channels()));
      return ret;
    }
  }
  return convert(env, m);
}

template <> cv::Mat convert(const Napi::Value &value) {
  if (!value.IsTypedArray())
    throw JS::TypeError(value.Env(), "Argument must be a TypedArray");
  const auto &typed_array = value.As<Napi::TypedArray>();
  if (!typed_array.Has("shape"))
    throw JS::TypeError(value.Env(), "Mat object must have 'shape' property");
  if (!typed_array.Get("shape").IsArray())
    throw JS::TypeError(value.Env(), "Mat.shape must be an array");
  const auto shape = convert<std::vector<int>>(typed_array.Get("shape"));
  if (!typed_array.Has("channels"))
    throw JS::TypeError(value.Env(),
                        "Mat object must have 'channels' property");
  const auto channels = convert<int>(typed_array.Get("channels"));
  if (channels <= 0)
    throw JS::TypeError(value.Env(), "Mat.channels must be a positive integer");
  if (channels > CV_CN_MAX)
    throw JS::TypeError(value.Env(), "Number of channels " +
                                         std::to_string(channels) +
                                         " exceeds OpenCV maximum of " +
                                         std::to_string(CV_CN_MAX));
  cv::Mat mat;
  switch (typed_array.TypedArrayType()) {
  case napi_uint8_array:
    mat = cv::Mat(shape, CV_8UC(channels));
    break;
  case napi_int8_array:
    mat = cv::Mat(shape, CV_8SC(channels));
    break;
  case napi_uint16_array:
    mat = cv::Mat(shape, CV_16UC(channels));
    break;
  case napi_int16_array:
    mat = cv::Mat(shape, CV_16SC(channels));
    break;
  case napi_int32_array:
    mat = cv::Mat(shape, CV_32SC(channels));
    break;
  case napi_float32_array:
    mat = cv::Mat(shape, CV_32FC(channels));
    break;
  case napi_float64_array:
    mat = cv::Mat(shape, CV_64FC(channels));
    break;
  default:
    throw JS::TypeError(value.Env(), "Unsupported TypedArray type for Mat");
  }
  const auto byteLength = typed_array.ByteLength();
  const auto expectedSize = mat.size().area() * mat.elemSize();
  if (byteLength != expectedSize)
    throw JS::TypeError(value.Env(), "TypedArray size " +
                                         std::to_string(byteLength) +
                                         " does not match expected Mat size " +
                                         std::to_string(expectedSize));
  std::memcpy(mat.data, typed_array.ArrayBuffer().Data(), byteLength);
  return mat;
}

CONVERT_ARRAY_OF(cv::Mat);

template <> CameraCalibration convert(const Napi::Value &value) {
  if (!value.IsObject())
    throw JS::TypeError(value.Env(), "Argument must be an object");
  const auto &obj = value.As<Napi::Object>();
  CameraCalibration cal;
  if (obj.Has("camera_matrix"))
    cal.camera_matrix = convert<cv::Mat>(obj.Get("camera_matrix"));
  else
    throw JS::TypeError(value.Env(),
                        "CameraCalibration must have camera_matrix defined");
  if (obj.Has("dist_coeffs"))
    cal.dist_coeffs = convert<cv::Mat>(obj.Get("dist_coeffs"));
  else
    throw JS::TypeError(value.Env(),
                        "CameraCalibration must have dist_coeffs defined");
  if (obj.Has("rvecs"))
    cal.rvecs = convert<std::vector<cv::Mat>>(obj.Get("rvecs"));
  if (obj.Has("tvecs"))
    cal.tvecs = convert<std::vector<cv::Mat>>(obj.Get("tvecs"));
  return cal;
}

template <> CameraCalibration::Ptr convert(const Napi::Value &value) {
  if (!value.IsObject())
    throw JS::TypeError(value.Env(), "Argument must be an object");
  const auto &obj = value.As<Napi::Object>();
  auto cal = CameraCalibration::create();
  cal->sensor_size = convert<cv::Size2i>(obj.Get("sensor_size"));
  cal->camera_matrix = convert<cv::Mat>(obj.Get("camera_matrix"));
  cal->dist_coeffs = convert<cv::Mat>(obj.Get("dist_coeffs"));
  cal->rvecs = convert<std::vector<cv::Mat>>(obj.Get("rvecs"));
  cal->tvecs = convert<std::vector<cv::Mat>>(obj.Get("tvecs"));
  return cal;
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const CameraCalibration::Ptr &cal) noexcept {
  auto obj = Napi::Object::New(env);
  obj.Set("sensor_size", convert(env, cal->sensor_size));
  obj.Set("camera_matrix", convert(env, cal->camera_matrix));
  obj.Set("dist_coeffs", convert(env, cal->dist_coeffs));
  obj.Set("rvecs", convert(env, cal->rvecs));
  obj.Set("tvecs", convert(env, cal->tvecs));
  return obj;
}

template <> cv::TermCriteria convert(const Napi::Value &value) {
  if (value.IsUndefined())
    return cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 30,
                            0.01);
  if (!value.IsObject())
    throw JS::TypeError(value.Env(), "Argument must be an object");
  const auto &obj = value.As<Napi::Object>();
  int type = 0;
  int max_count = 0;
  double epsilon = 0;
  if (obj.Has("max_count")) {
    type |= cv::TermCriteria::MAX_ITER;
    max_count = convert<int>(obj.Get("max_count"));
  }
  if (obj.Has("epsilon")) {
    type |= cv::TermCriteria::EPS;
    epsilon = convert<double>(obj.Get("epsilon"));
  }
  if (type == 0)
    throw JS::TypeError(value.Env(), "TermCriteria must have at least one of "
                                     "max_count or epsilon defined");
  return cv::TermCriteria(type, max_count, epsilon);
}