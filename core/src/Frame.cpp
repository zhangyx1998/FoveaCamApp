// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstring>

#include <Aravis/Frame.h>
#include <Buffer/Buffer.h>
#include <utils/map-set.h>

#include "Aravis/PixelFormat.h"
#include "AsyncTask.h"
#include "CoreObject.h"
#include "ShmRing.h"
#include "napi-helper.h"

using namespace Napi;

static void writeFrameViewInto(Arv::Frame::Ptr frame, Arv::PixelFormat fmt,
                               const ShmRing::WriteTarget &target) {
  cv::Mat dst(target.shape, CV_MAKETYPE(CV_8U, target.channels), target.data);
  if (target.bytes != static_cast<size_t>(dst.total() * dst.elemSize()))
    throw std::runtime_error("SHM slot byte size does not match frame shape");
  const int expected = convert<cv::Format>(fmt);
  if (dst.type() != expected)
    throw std::runtime_error("SHM slot type does not match requested format");

  if (frame->format == fmt) {
    frame->raw.copyTo(dst);
    return;
  }

  try {
    cv::Mat converted;
    cv::cvtColor(frame->raw, converted, cvtColorCode(frame->format, fmt));
    const int dstDepth = CV_MAT_DEPTH(expected);
    if (dstDepth == CV_8U && converted.depth() != CV_8U) {
      const double maxVal = (1 << significantBits(frame->format)) - 1;
      converted.convertTo(dst, expected, 255.0 / maxVal);
    } else {
      converted.copyTo(dst);
    }
  } catch (const Arv::UnknownPixelFormat &) {
    throw std::runtime_error("Unsupported pixel format conversion from " +
                             convert<std::string>(frame->format) + " to " +
                             convert<std::string>(fmt));
  }
}

class ShmFrameViewTask : public Napi::AsyncWorker {
  Napi::Promise::Deferred deferred;
  Arv::Frame::Ptr frame;
  Arv::PixelFormat fmt;
  ShmRing::WriteTarget target;

public:
  ShmFrameViewTask(Napi::Env env, Arv::Frame::Ptr frame, Arv::PixelFormat fmt,
                   ShmRing::WriteTarget target)
      : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)),
        frame(std::move(frame)), fmt(fmt), target(std::move(target)) {}

  void Execute() override { writeFrameViewInto(frame, fmt, target); }

  void OnOK() override { deferred.Resolve(Env().Undefined()); }

  void OnError(const Napi::Error &e) override { deferred.Reject(e.Value()); }

  Napi::Promise promise() const { return deferred.Promise(); }
};

template <> Arv::PixelFormat convert(const Napi::Value &value) {
  return convert<Arv::PixelFormat>(value.As<Napi::String>().Utf8Value());
}

class FrameObject : public CoreObject<FrameObject, Arv::Frame::Ptr> {
  CORE_OBJECT_DECL(FrameObject);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "Frame";
  static Function Init(Napi::Env env) {
    return DefineClass(env, FrameObject::name.c_str(),
                       {
                           CORE_OBJECT_REGISTER(FrameObject, env),   //
                           INSTANCE_METHOD(FrameObject, view),       //
                           INSTANCE_METHOD(FrameObject, save),       //
                           INSTANCE_GETTER(FrameObject, width),      //
                           INSTANCE_GETTER(FrameObject, height),     //
                           INSTANCE_GETTER(FrameObject, timestamp),  //
                           INSTANCE_GETTER(FrameObject, device_timestamp), //
                           INSTANCE_GETTER(FrameObject, system_timestamp), //
                           INSTANCE_GETTER(FrameObject, deviceTimestamp), //
                           INSTANCE_GETTER(FrameObject, systemTimestamp), //
                           INSTANCE_GETTER(FrameObject, raw),        //
                           INSTANCE_GETTER(FrameObject, raw_format), //
                       });
  }

  static std::string describe(const FrameObject *obj) {
    return obj->core()->tag;
  }

private:
  FN(view) {
    try {
      const auto fmt = optionalArgument(info[0], Arv::PixelFormat::BGRA8);
      const auto container = optionalArgument(info[1]);
      if (ShmRing::isSlot(container)) {
        auto worker =
            new ShmFrameViewTask(env, core(), fmt, ShmRing::writeTarget(container));
        auto promise = worker->promise();
        worker->Queue();
        return promise;
      }
      if (core()->isAvailable(fmt)) {
        // Resolve immediately if already available
        auto deferred = Promise::Deferred::New(env);
        deferred.Resolve(convert(env, container, core()->view(fmt)));
        return deferred.Promise();
      } else {
        // Launch one-shot async worker to convert
        auto task = [core = core(), fmt] {
          auto result = core->view(fmt);
          return result;
        };
        return AsyncTask<cv::Mat>::run(container, task,
                                       "Frame[" + core()->tag + "].view(" +
                                           convert<std::string>(fmt) + ")");
      }
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(save) {
    try {
      const auto path = convert<std::string>(info[0]);
      cv::imwrite(path, core()->raw);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(width) { return Number::New(env, core()->width()); }

  GET(height) { return Number::New(env, core()->height()); }

  GET(timestamp) { return BigInt::New(env, core()->timestamp); }

  GET(device_timestamp) {
    return BigInt::New(env, core()->device_timestamp);
  }

  GET(system_timestamp) {
    return BigInt::New(env, core()->system_timestamp);
  }

  GET(deviceTimestamp) {
    return BigInt::New(env, core()->device_timestamp);
  }

  GET(systemTimestamp) {
    return BigInt::New(env, core()->system_timestamp);
  }

  GET(raw) { return convert(env, core()->raw); }

  GET(raw_format) {
    return convert(env, (convert<std::string>(core()->format)));
  }
};

CORE_OBJECT(FrameObject);
