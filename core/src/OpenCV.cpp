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
#include <stdexcept>
#include <string>
#include <vector>

#include "Vision.h"
#include "napi-helper.h"

#define CVT(TPL, EL, N, ...)                                                   \
  template <> TPL<EL> convert(const Napi::Value &value) {                      \
    if (!value.IsObject())                                                     \
      throw JS::TypeError(value.Env(), "Argument must be an object");          \
    auto obj = value.As<Napi::Object>();                                       \
    return CVT_CONSTRUCT_NATIVE_##N(TPL, EL, __VA_ARGS__);                     \
  }                                                                            \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const Napi::Value &container,             \
                      const TPL<EL> &src) noexcept {                           \
    if (!container.IsObject())                                                 \
      JS_THROW(TypeError, "Container of " #TPL "<" #EL "> must be an object",  \
               container);                                                     \
    auto obj = container.As<Napi::Object>();                                   \
    CVT_CONSTRUCT_JS_OBJ_##N(__VA_ARGS__) return container;                    \
  }                                                                            \
  template <>                                                                  \
  Napi::Value convert(Napi::Env env, const TPL<EL> &src) noexcept {            \
    return convert(env, Napi::Object::New(env).As<Napi::Value>(), src);        \
  }                                                                            \
  /* 1D Vector */                                                              \
  CONVERT_ARRAY_OF(TPL<EL>);                                                   \
  /* 2D Vector */                                                              \
  CONVERT_ARRAY_OF(std::vector<TPL<EL>>);

#define CVT_CONSTRUCT_NATIVE_2(TPL, EL, KX, KY)                                \
  TPL<EL>(convert<EL>(obj.Get(#KX)), convert<EL>(obj.Get(#KY)))

#define CVT_CONSTRUCT_JS_OBJ_2(KX, KY)                                         \
  obj.Set(#KX, convert(env, src.KX));                                          \
  obj.Set(#KY, convert(env, src.KY));

#define CVT_CONSTRUCT_NATIVE_3(TPL, EL, KX, KY, KZ)                            \
  TPL<EL>(convert<EL>(obj.Get(#KX)), convert<EL>(obj.Get(#KY)),                \
          convert<EL>(obj.Get(#KZ)))

#define CVT_CONSTRUCT_JS_OBJ_3(KX, KY, KZ)                                     \
  obj.Set(#KX, convert(env, src.KX));                                          \
  obj.Set(#KY, convert(env, src.KY));                                          \
  obj.Set(#KZ, convert(env, src.KZ));

#define CVT_CONSTRUCT_NATIVE_4(TPL, EL, KX, KY, KW, KH)                        \
  TPL<EL>(convert<EL>(obj.Get(#KX)), convert<EL>(obj.Get(#KY)),                \
          convert<EL>(obj.Get(#KW)), convert<EL>(obj.Get(#KH)))

#define CVT_CONSTRUCT_JS_OBJ_4(KX, KY, KW, KH)                                 \
  obj.Set(#KX, convert(env, src.KX));                                          \
  obj.Set(#KY, convert(env, src.KY));                                          \
  obj.Set(#KW, convert(env, src.KW));                                          \
  obj.Set(#KH, convert(env, src.KH));

CVT(cv::Size_, int, 2, width, height)
CVT(cv::Size_, int64, 2, width, height)
CVT(cv::Size_, float, 2, width, height)
CVT(cv::Size_, double, 2, width, height)

CVT(cv::Point_, int, 2, x, y)
CVT(cv::Point_, int64, 2, x, y)
CVT(cv::Point_, float, 2, x, y)
CVT(cv::Point_, double, 2, x, y)

CVT(cv::Point3_, int, 3, x, y, z)
CVT(cv::Point3_, int64, 3, x, y, z)
CVT(cv::Point3_, float, 3, x, y, z)
CVT(cv::Point3_, double, 3, x, y, z)

CVT(cv::Rect_, int, 4, x, y, width, height)
CVT(cv::Rect_, int64, 4, x, y, width, height)
CVT(cv::Rect_, float, 4, x, y, width, height)
CVT(cv::Rect_, double, 4, x, y, width, height)

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
    throw JS::TypeError(env, "Unsupported Mat type " +                         \
                                 std::to_string(MAT.type()) +                  \
                                 " (converting to TypedArray)");               \
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

typedef struct MatDescriptor {
  const Napi::TypedArray &arr;
  inline Napi::Env env() const { return arr.Env(); }
  int depth() const {
    const auto type = arr.TypedArrayType();
    switch (type) {
    case napi_uint8_array:
      return CV_8U;
    case napi_int8_array:
      return CV_8S;
    case napi_uint16_array:
      return CV_16U;
    case napi_int16_array:
      return CV_16S;
    case napi_int32_array:
      return CV_32S;
    case napi_float32_array:
      return CV_32F;
    case napi_float64_array:
      return CV_64F;
    default:
      throw JS::TypeError(env(), "Unsupported TypedArray type " +
                                     std::to_string(type));
    }
  }
  std::vector<int32_t> shape() const {
    if (!arr.Has("shape") or !arr.Get("shape").IsArray())
      throw JS::TypeError(arr.Env(), "Mat.shape must be an array of integers");
    return convert<std::vector<int>>(arr.Get("shape"));
  }
  int channels() const {
    if (!arr.Has("channels"))
      throw JS::TypeError(arr.Env(), "Mat.channels must be defined");
    const auto channels = convert<int>(arr.Get("channels"));
    if (channels <= 0)
      throw JS::TypeError(arr.Env(), "Mat.channels must be a positive integer");
    if (channels > CV_CN_MAX)
      throw JS::TypeError(arr.Env(), "Number of channels " +
                                         std::to_string(channels) +
                                         " exceeds OpenCV maximum of " +
                                         std::to_string(CV_CN_MAX));
    return channels;
  }
  int type() const { return CV_MAKETYPE(depth(), channels()); }
  uchar *const data() const {
    return static_cast<uchar *>(arr.ArrayBuffer().Data()) + arr.ByteOffset();
  }
  inline void sizeCheck(size_t expected) const {
    if (arr.ByteLength() != expected)
      throw JS::TypeError(env(), "TypedArray byte length " +
                                     std::to_string(arr.ByteLength()) +
                                     " does not match expected size " +
                                     std::to_string(expected));
  }
  inline void sizeCheck(const cv::Mat &mat) const {
    sizeCheck(mat.size().area() * mat.elemSize());
  }
  MatDescriptor(const Napi::TypedArray &arr) : arr(arr) {}
} MatDescriptor;

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::MatSize &size) noexcept {
  return convert(env, size);
}

template <> Napi::Value convert(Napi::Env env, const cv::Mat &mat) noexcept {
  try {
    const auto m = (mat.empty() || mat.isContinuous()) ? mat : mat.clone();
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
  JS_EXCEPT(env.Null())
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
      try {
        MATCH_MAT_TYPE(m, ret, size, array_buffer, byte_offset);
      }
      JS_EXCEPT(env.Undefined())
      ret.As<Napi::Object>().Set("shape", convert(env, m.size));
      ret.As<Napi::Object>().Set("channels", convert(env, m.channels()));
      return ret;
    }
  }
  return convert(env, m);
}

template <> cv::Mat convert(const Napi::Value &value) {
  const auto env = value.Env();
  if (!value.IsTypedArray())
    throw JS::TypeError(env, "Argument must be a TypedArray");
  const auto &typed_array = value.As<Napi::TypedArray>();
  const MatDescriptor desc(typed_array);
  auto mat = cv::Mat(desc.shape(), desc.type());
  const auto expectedSize = mat.size().area() * mat.elemSize();
  desc.sizeCheck(mat);
  std::memcpy(mat.data, desc.data(), expectedSize);
  return mat;
}

CONVERT_ARRAY_OF(cv::Mat);

template <>
Napi::Value convert(Napi::Env env, const cv::MatView &view) noexcept {
  try {
    if (!view.ref.IsEmpty())
      return view.ref.Value();
    else
      return convert(env, static_cast<const cv::Mat &>(view));
  }
  JS_EXCEPT(env.Null())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::MatView &view) noexcept {
  if (isBufferLike(container))
    return convert(env, container, static_cast<const cv::Mat &>(view));
  return convert(env, view);
}

template <> cv::MatView convert(const Napi::Value &value) {
  const auto env = value.Env();
  if (!value.IsTypedArray())
    throw JS::TypeError(env, "Argument must be a TypedArray");
  const auto &typed_array = value.As<Napi::TypedArray>();
  const MatDescriptor desc(typed_array);
  cv::MatView view(value, desc.shape(), desc.type(), desc.data());
  desc.sizeCheck(view);
  return view;
}

cv::MatView cv::MatView::like(const Napi::Env &env, const cv::Mat &mat) {
  const auto size = mat.size().area() * mat.elemSize();
  auto array_buffer = Napi::ArrayBuffer::New(env, size);
  Napi::Object ret;
  MATCH_MAT_TYPE(mat, ret, size, array_buffer, 0);
  ret.Set("shape", convert(env, mat.size));
  ret.Set("channels", convert(env, mat.channels()));
  return MatView(ret, cv::Mat(mat.size(), mat.type(), array_buffer.Data()));
}

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
  // Optional (additive): absent on calibrations persisted before `rms` existed.
  if (obj.Has("rms"))
    cal->rms = convert<double>(obj.Get("rms"));
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
  obj.Set("rms", convert(env, cal->rms));
  return obj;
}

template <> cv::TermCriteria convert(const Napi::Value &value) {
  if (value.IsUndefined())
    return cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS, 30,
                            1e-8);
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

// Enums
template <> CvtColorCode convert(const std::string &value) {
  CASE_STRING_TO_ENUM(value, BGR2BGRA);
  CASE_STRING_TO_ENUM(value, RGB2RGBA);
  CASE_STRING_TO_ENUM(value, BGRA2BGR);
  CASE_STRING_TO_ENUM(value, RGBA2RGB);
  CASE_STRING_TO_ENUM(value, BGR2RGBA);
  CASE_STRING_TO_ENUM(value, RGB2BGRA);
  CASE_STRING_TO_ENUM(value, RGBA2BGR);
  CASE_STRING_TO_ENUM(value, BGRA2RGB);
  CASE_STRING_TO_ENUM(value, BGR2RGB);
  CASE_STRING_TO_ENUM(value, RGB2BGR);
  CASE_STRING_TO_ENUM(value, BGRA2RGBA);
  CASE_STRING_TO_ENUM(value, RGBA2BGRA);
  CASE_STRING_TO_ENUM(value, BGR2GRAY);
  CASE_STRING_TO_ENUM(value, RGB2GRAY);
  CASE_STRING_TO_ENUM(value, GRAY2BGR);
  CASE_STRING_TO_ENUM(value, GRAY2RGB);
  CASE_STRING_TO_ENUM(value, GRAY2BGRA);
  CASE_STRING_TO_ENUM(value, GRAY2RGBA);
  CASE_STRING_TO_ENUM(value, BGRA2GRAY);
  CASE_STRING_TO_ENUM(value, RGBA2GRAY);
  CASE_STRING_TO_ENUM(value, BayerBG2BGR);
  CASE_STRING_TO_ENUM(value, BayerGB2BGR);
  CASE_STRING_TO_ENUM(value, BayerRG2BGR);
  CASE_STRING_TO_ENUM(value, BayerGR2BGR);
  CASE_STRING_TO_ENUM(value, BayerRGGB2BGR);
  CASE_STRING_TO_ENUM(value, BayerGRBG2BGR);
  CASE_STRING_TO_ENUM(value, BayerBGGR2BGR);
  CASE_STRING_TO_ENUM(value, BayerGBRG2BGR);
  CASE_STRING_TO_ENUM(value, BayerRGGB2RGB);
  CASE_STRING_TO_ENUM(value, BayerGRBG2RGB);
  CASE_STRING_TO_ENUM(value, BayerBGGR2RGB);
  CASE_STRING_TO_ENUM(value, BayerGBRG2RGB);
  CASE_STRING_TO_ENUM(value, BayerBG2RGB);
  CASE_STRING_TO_ENUM(value, BayerGB2RGB);
  CASE_STRING_TO_ENUM(value, BayerRG2RGB);
  CASE_STRING_TO_ENUM(value, BayerGR2RGB);
  CASE_STRING_TO_ENUM(value, BayerBG2GRAY);
  CASE_STRING_TO_ENUM(value, BayerGB2GRAY);
  CASE_STRING_TO_ENUM(value, BayerRG2GRAY);
  CASE_STRING_TO_ENUM(value, BayerGR2GRAY);
  CASE_STRING_TO_ENUM(value, BayerRGGB2GRAY);
  CASE_STRING_TO_ENUM(value, BayerGRBG2GRAY);
  CASE_STRING_TO_ENUM(value, BayerBGGR2GRAY);
  CASE_STRING_TO_ENUM(value, BayerGBRG2GRAY);
  throw std::range_error("Unsupported CvtColorCode enum string: " + value);
}

template <> CvtColorCode convert(const Napi::Value &value) {
  if (value.IsNumber())
    return static_cast<CvtColorCode>(convert<int>(value));
  if (!value.IsString())
    throw JS::TypeError(value.Env(), "CvtColorCode must be a string");
  return convert<CvtColorCode>(value.As<Napi::String>().Utf8Value());
}

template <> std::string convert(const cv::SolvePnPMethod &value) {
  CASE_ENUM_TO_STRING(value, ITERATIVE, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, P3P, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, AP3P, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, EPNP, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, DLS, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, UPNP, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, IPPE, cv::SOLVEPNP_);
  CASE_ENUM_TO_STRING(value, IPPE_SQUARE, cv::SOLVEPNP_);
  throw std::range_error("Unsupported SolvePnPMethod enum value: " +
                         std::to_string(value));
}

template <> cv::SolvePnPMethod convert(const std::string &value) {
  CASE_STRING_TO_ENUM(value, ITERATIVE, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, P3P, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, AP3P, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, EPNP, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, DLS, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, UPNP, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, IPPE, cv::SOLVEPNP_);
  CASE_STRING_TO_ENUM(value, IPPE_SQUARE, cv::SOLVEPNP_);
  throw std::range_error("Unsupported SolvePnPMethod enum string: " + value);
}

template <> cv::SolvePnPMethod convert(const Napi::Value &value) {
  if (!value.IsString())
    throw JS::TypeError(value.Env(), "SolvePnPMethod must be a string");
  return convert<cv::SolvePnPMethod>(value.As<Napi::String>().Utf8Value());
}

template <>
Napi::Value convert(Napi::Env env, const cv::SolvePnPMethod &value) noexcept {
  try {
    return convert(env, convert<std::string>(value));
  }
  JS_EXCEPT(env.Undefined())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::SolvePnPMethod &value) noexcept {
  return convert(env, value);
}

template <> std::string convert(const cv::TemplateMatchModes &value) {
  CASE_ENUM_TO_STRING(value, SQDIFF, cv::TM_);
  CASE_ENUM_TO_STRING(value, SQDIFF_NORMED, cv::TM_);
  CASE_ENUM_TO_STRING(value, CCORR, cv::TM_);
  CASE_ENUM_TO_STRING(value, CCORR_NORMED, cv::TM_);
  CASE_ENUM_TO_STRING(value, CCOEFF, cv::TM_);
  CASE_ENUM_TO_STRING(value, CCOEFF_NORMED, cv::TM_);
  throw std::range_error("Unsupported TemplateMatchModes enum value: " +
                         std::to_string(value));
}

template <> cv::TemplateMatchModes convert(const std::string &value) {
  CASE_STRING_TO_ENUM(value, SQDIFF, cv::TM_);
  CASE_STRING_TO_ENUM(value, SQDIFF_NORMED, cv::TM_);
  CASE_STRING_TO_ENUM(value, CCORR, cv::TM_);
  CASE_STRING_TO_ENUM(value, CCORR_NORMED, cv::TM_);
  CASE_STRING_TO_ENUM(value, CCOEFF, cv::TM_);
  CASE_STRING_TO_ENUM(value, CCOEFF_NORMED, cv::TM_);
  throw std::range_error("Unsupported TemplateMatchModes enum string: " +
                         value);
}

template <> cv::TemplateMatchModes convert(const Napi::Value &value) {
  if (!value.IsString())
    throw JS::TypeError(value.Env(), "TemplateMatchModes must be a string");
  return convert<cv::TemplateMatchModes>(value.As<Napi::String>().Utf8Value());
}

template <>
Napi::Value convert(Napi::Env env,
                    const cv::TemplateMatchModes &value) noexcept {
  try {
    return convert(env, convert<std::string>(value));
  }
  JS_EXCEPT(env.Undefined())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::TemplateMatchModes &value) noexcept {
  return convert(env, value);
}

template <> std::string convert(const cv::InterpolationFlags &value) {
  CASE_ENUM_TO_STRING(value, NEAREST, cv::INTER_);
  CASE_ENUM_TO_STRING(value, LINEAR, cv::INTER_);
  CASE_ENUM_TO_STRING(value, CUBIC, cv::INTER_);
  CASE_ENUM_TO_STRING(value, AREA, cv::INTER_);
  CASE_ENUM_TO_STRING(value, LANCZOS4, cv::INTER_);
  CASE_ENUM_TO_STRING(value, LINEAR_EXACT, cv::INTER_);
  CASE_ENUM_TO_STRING(value, NEAREST_EXACT, cv::INTER_);
  CASE_ENUM_TO_STRING(value, MAX, cv::INTER_);
  throw std::range_error("Unsupported InterpolationFlag enum value: " +
                         std::to_string(value));
}

template <> cv::InterpolationFlags convert(const std::string &value) {
  CASE_STRING_TO_ENUM(value, NEAREST, cv::INTER_);
  CASE_STRING_TO_ENUM(value, LINEAR, cv::INTER_);
  CASE_STRING_TO_ENUM(value, CUBIC, cv::INTER_);
  CASE_STRING_TO_ENUM(value, AREA, cv::INTER_);
  CASE_STRING_TO_ENUM(value, LANCZOS4, cv::INTER_);
  CASE_STRING_TO_ENUM(value, LINEAR_EXACT, cv::INTER_);
  CASE_STRING_TO_ENUM(value, NEAREST_EXACT, cv::INTER_);
  CASE_STRING_TO_ENUM(value, MAX, cv::INTER_);
  throw std::range_error("Unsupported InterpolationFlag enum string: " + value);
}

template <> cv::InterpolationFlags convert(const Napi::Value &value) {
  if (!value.IsString())
    throw JS::TypeError(value.Env(), "InterpolationFlag must be a string");
  return convert<cv::InterpolationFlags>(value.As<Napi::String>().Utf8Value());
}

template <>
Napi::Value convert(Napi::Env env,
                    const cv::InterpolationFlags &value) noexcept {
  try {
    return convert(env, convert<std::string>(value));
  }
  JS_EXCEPT(env.Undefined())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const cv::InterpolationFlags &value) noexcept {
  return convert(env, value);
}

template <> std::string convert(const EstimationMethod &value) {
  CASE_ENUM_TO_STRING(value, LMEDS);
  CASE_ENUM_TO_STRING(value, RANSAC);
  CASE_ENUM_TO_STRING(value, RHO);
  CASE_ENUM_TO_STRING(value, USAC_DEFAULT);
  CASE_ENUM_TO_STRING(value, USAC_PARALLEL);
  CASE_ENUM_TO_STRING(value, USAC_FM_8PTS);
  CASE_ENUM_TO_STRING(value, USAC_FAST);
  CASE_ENUM_TO_STRING(value, USAC_ACCURATE);
  CASE_ENUM_TO_STRING(value, USAC_PROSAC);
  CASE_ENUM_TO_STRING(value, USAC_MAGSAC);
  throw std::range_error("Unsupported EstimationMethod enum value: " +
                         std::to_string(value));
}

template <> EstimationMethod convert(const std::string &value) {
  CASE_STRING_TO_ENUM(value, LMEDS);
  CASE_STRING_TO_ENUM(value, RANSAC);
  CASE_STRING_TO_ENUM(value, RHO);
  CASE_STRING_TO_ENUM(value, USAC_DEFAULT);
  CASE_STRING_TO_ENUM(value, USAC_PARALLEL);
  CASE_STRING_TO_ENUM(value, USAC_FM_8PTS);
  CASE_STRING_TO_ENUM(value, USAC_FAST);
  CASE_STRING_TO_ENUM(value, USAC_ACCURATE);
  CASE_STRING_TO_ENUM(value, USAC_PROSAC);
  CASE_STRING_TO_ENUM(value, USAC_MAGSAC);
  throw std::range_error("Unsupported EstimationMethod enum string: " + value);
}

template <> EstimationMethod convert(const Napi::Value &value) {
  if (!value.IsString())
    throw JS::TypeError(value.Env(), "EstimationMethod must be a string");
  return convert<EstimationMethod>(value.As<Napi::String>().Utf8Value());
}

template <>
Napi::Value convert(Napi::Env env, const EstimationMethod &value) noexcept {
  try {
    return convert(env, convert<std::string>(value));
  }
  JS_EXCEPT(env.Undefined())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const EstimationMethod &value) noexcept {
  return convert(env, value);
}
