// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>
#include <opencv2/aruco.hpp>
#include <opencv2/core.hpp>
#include <opencv2/objdetect/aruco_dictionary.hpp>

#include <Aravis/Frame.h>
#include <Aravis/PixelFormat.h>
#include <Aravis/Stream.h>
#include <pointer.h>
#include <stdexcept>

#include "Iterator.h"
#include "napi-helper.h"

using namespace Napi;
using namespace cv;
using DictType = aruco::PredefinedDictionaryType;

template <> std::string convert(const DictType &type) {
#define CASE(NAME)                                                             \
  case DictType::DICT_##NAME:                                                  \
    return #NAME;
  switch (type) {
    CASE(4X4_50);
    CASE(4X4_100);
    CASE(4X4_250);
    CASE(4X4_1000);
    CASE(5X5_50);
    CASE(5X5_100);
    CASE(5X5_250);
    CASE(5X5_1000);
    CASE(6X6_50);
    CASE(6X6_100);
    CASE(6X6_250);
    CASE(6X6_1000);
    CASE(7X7_50);
    CASE(7X7_100);
    CASE(7X7_250);
    CASE(7X7_1000);
    CASE(ARUCO_ORIGINAL);
    CASE(APRILTAG_16h5);
    CASE(APRILTAG_25h9);
    CASE(APRILTAG_36h10);
    CASE(APRILTAG_36h11);
    CASE(ARUCO_MIP_36h12);
  default:
    throw std::invalid_argument("Invalid ArUco dictionary type: " +
                                std::to_string(type));
  }
#undef CASE
}

template <> DictType convert(const std::string &type) {
#define CASE(NAME)                                                             \
  if (type == #NAME)                                                           \
    return DictType::DICT_##NAME;
  CASE(4X4_50);
  CASE(4X4_100);
  CASE(4X4_250);
  CASE(4X4_1000);
  CASE(5X5_50);
  CASE(5X5_100);
  CASE(5X5_250);
  CASE(5X5_1000);
  CASE(6X6_50);
  CASE(6X6_100);
  CASE(6X6_250);
  CASE(6X6_1000);
  CASE(7X7_50);
  CASE(7X7_100);
  CASE(7X7_250);
  CASE(7X7_1000);
  CASE(ARUCO_ORIGINAL);
  CASE(APRILTAG_16h5);
  CASE(APRILTAG_25h9);
  CASE(APRILTAG_36h10);
  CASE(APRILTAG_36h11);
  CASE(ARUCO_MIP_36h12);
  throw std::invalid_argument("Invalid ArUco dictionary type: " + type);
#undef CASE
}

template <> DictType convert(const Napi::Value &value) {
  return convert<DictType>(convert<std::string>(value));
}

template <> Napi::Value convert(Napi::Env env, const DictType &type) noexcept {
  try {
    return convert(env, convert<std::string>(type));
  }
  JS_EXCEPT(env.Undefined())
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const DictType &type) noexcept {
  return convert(env, type);
}

typedef struct Detection {
  int id;
  std::vector<Point2f> corners;
} Detection;

typedef struct ArUcoDetectionResult : public Shared<ArUcoDetectionResult> {
  const Arv::Frame::Ptr frame;
  std::vector<Detection> detections;
  ArUcoDetectionResult(const Arv::Frame::Ptr &frame) : frame(frame) {};
} ArUcoDetectionResult;

using Result = ArUcoDetectionResult;

template <> Value convert(Napi::Env env, const Result::Ptr &results) noexcept {
  VERBOSE("Converting ArUcoDetectionResult[%p] to JS object (%lu results)",
          results.get(), results->detections.size());
  auto arr = Array::New(env, results->detections.size());
  for (size_t i = 0; i < results->detections.size(); ++i) {
    const auto &result = results->detections[i];
    auto el = Array::New(env, result.corners.size());
    const auto w = Number::New(env, results->frame->width());
    const auto h = Number::New(env, results->frame->height());
    el.Set("id", Number::New(env, result.id));
    el.Set("width", w);
    el.Set("height", h);
    for (size_t j = 0; j < result.corners.size(); ++j) {
      auto pt = Napi::Object::New(env);
      pt.Set("x", Number::New(env, result.corners[j].x));
      pt.Set("y", Number::New(env, result.corners[j].y));
      pt.Freeze();
      el.Set(j, pt);
    }
    el.Freeze();
    arr.Set(i, el);
  }
  arr.Set("frame", convert(env, results->frame));
  arr.Freeze();
  return arr;
};

template <>
Value convert(Napi::Env env, const Napi::Value &container,
              const Result::Ptr &results) noexcept {
  return convert(env, results);
};

inline Result::Ptr detect(const Arv::Frame::Ptr &frame,
                          const cv::Ptr<aruco::Dictionary> &dict,
                          double scale = 1.0) {
  auto gray = frame->view(Arv::PixelFormat::Mono8);
  cv::Mat mat;
  if (scale != 1.0)
    cv::resize(gray, mat, {}, scale, scale, cv::INTER_AREA);
  else
    mat = gray;
  cv::normalize(mat, mat, 0, 255, cv::NORM_MINMAX);
  std::vector<int> ids;
  std::vector<std::vector<cv::Point2f>> corners;
  aruco::detectMarkers(mat, dict, corners, ids);
  if (ids.size() != corners.size())
    throw std::runtime_error("Detected ids and corners size mismatch");
  auto n = ids.size();
  // Scale corners back to original size
  if (scale != 1.0)
    for (auto &corner_set : corners)
      for (auto &pt : corner_set)
        pt /= scale;
  // Save results
  auto results = Result::create(frame);
  results->detections.reserve(n);
  for (size_t i = 0; i < n; ++i) {
    cv::cornerSubPix(
        gray, corners[i], cv::Size(9, 9), cv::Size(-1, -1),
        cv::TermCriteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER,
                         100, 0.1));
    results->detections.push_back(Detection{ids[i], corners[i]});
  }
  return results;
}

class ArUcoStream : public TransformStream<Arv::Frame::Ptr, Result::Ptr>,
                    public Shared<ArUcoStream> {
public:
  const Arv::Stream::Ptr stream;
  const cv::Ptr<aruco::Dictionary> dict;
  const double scale;
  ArUcoStream(const Arv::Stream::Ptr &upstream,
              const cv::Ptr<aruco::Dictionary> &dict, double scale)
      : stream(upstream), dict(dict), scale(scale) {}
  ~ArUcoStream() { shutdown(); }
  Stream<Arv::Frame::Ptr> *upstream() override { return stream.get(); }
  Result::Ptr transform(const Arv::Frame::Ptr &input) override {
    VERBOSE("ArUcoStream::transform(%p) start", input.get());
    auto result = detect(input, dict, scale);
    VERBOSE("ArUcoStream::transform(%p) done", input.get());
    return result;
  }
};

class ArUcoDetectorObject : public ObjectWrap<ArUcoDetectorObject> {
public:
  static Function Init(Napi::Env env) {
    return DefineClass(env, "ArUcoDetector",
                       {
                           INSTANCE_GETTER(ArUcoDetectorObject, type),       //
                           INSTANCE_GETTER(ArUcoDetectorObject, markerSize), //
                           INSTANCE_METHOD(ArUcoDetectorObject, detect),     //
                           INSTANCE_METHOD(ArUcoDetectorObject, stream),     //
                           INSTANCE_METHOD(ArUcoDetectorObject, pattern),    //
                       });
  }

  ArUcoDetectorObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ArUcoDetectorObject>(info) {
    auto env = info.Env();
    try {
      const auto type = convert<DictType>(info[0]);
      dict = makePtr<aruco::Dictionary>(aruco::getPredefinedDictionary(type));
    }
    JS_EXCEPT()
  }

private:
  DictType dictType;
  Ptr<aruco::Dictionary> dict;

  GET(type) {
    const auto env = info.Env();
    try {
      return convert(env, dictType);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(markerSize) {
    const auto env = info.Env();
    try {
      return Number::New(env, dict->markerSize);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(detect) {
    auto env = info.Env();
    try {
      auto frame = convert<Arv::Frame::Ptr>(info[0]);
      const auto action = "ArUcoDetector.detect(" + frame->tag + ")";
      double scale = 1.0;
      if (info.Length() >= 2)
        scale = info[1].As<Napi::Number>().DoubleValue();
      if (scale <= 0.0)
        throw std::invalid_argument("Scale must be positive");
      VERBOSE("[Requested] %s", action.c_str());
      auto task = [dict = dict, frame, scale, action] {
        VERBOSE("[Dispatched] %s", action.c_str());
        auto result = ::detect(frame, dict, scale);
        VERBOSE("[Completed] %s", action.c_str());
        return result;
      };
      return OneShotWorker<Result::Ptr>::run(env, task);
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(stream) {
    auto env = info.Env();
    try {
      const double scale =
          info.Length() >= 2 ? info[1].As<Napi::Number>().DoubleValue() : 1.0;
      if (scale <= 0.0)
        throw std::invalid_argument("Scale must be positive");
      const auto upstream = convert<Arv::Stream::Ptr>(info[0]);
      const auto downstream = ArUcoStream::create(upstream, dict, scale);
      auto stream = StreamObject<ArUcoStream>::Create(env, downstream);
      if (stream.IsObject())
        stream.As<Napi::Object>().Set("upstream", info[0]);
      return stream;
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(pattern) {
    auto env = info.Env();
    try {
      const auto id = convert<int>(info[0]);
      if (id < 0 || id >= dict->bytesList.rows)
        throw JS::Error(env,
                        "Marker ID " + std::to_string(id) + " out of range");
      const auto &markerSize = dict->markerSize;
      const uchar *bytes = dict->bytesList.row(id).data;
      auto ret = Napi::Array::New(env, markerSize);
      unsigned index = 0;
      for (unsigned y = 0; y < markerSize; y++) {
        auto row = Array::New(env, markerSize);
        for (unsigned x = 0; x < markerSize; x++) {
          const auto byteIndex = index >> 3;
          const auto bitIndex = 0b111 - (index & 0b111);
          unsigned bit = (bytes[byteIndex] >> bitIndex) & 0b1;
          row.Set(x, Number::New(env, bit));
          index++;
        }
        ret.Set(y, row);
      }
      ret.Set("width", Number::New(env, markerSize));
      ret.Set("height", Number::New(env, markerSize));
      return ret;
    }
    JS_EXCEPT(env.Undefined())
  }
};

void exportArUcoDetectorObject(Napi::Env env, Napi::Object &exports) {
  exports.Set("ArUcoDetector", ArUcoDetectorObject::Init(env));
}
