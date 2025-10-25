// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstring>

#include <Aravis/Frame.h>
#include <Buffer/Buffer.h>
#include <utils/map-set.h>

#include "CoreObject.h"
#include "napi-helper.h"

using namespace Napi;

template <>
Value convert(Env env, const Value &container, const cv::Mat &mat) noexcept {
  const auto data = mat.data;
  const auto size = mat.size().area() * mat.elemSize();
  if (isBufferLike(container)) {
    auto buffer = bufferView(container);
    JS_ASSERT(buffer.size >= size, RangeError,
              "Destination buffer size too small", container);
    buffer.copyFrom(data, size);
    return container;
  } else {
#ifdef V8_MEMORY_CAGE
    auto ret = ArrayBuffer::New(env, size);
    std::memcpy(ret.Data(), data, size);
    return ret;
#else
    // Increment reference count on ImagePtr holding the buffer pointer
    auto ref = new cv::Mat(mat);
    // Return a borrowed ArrayBuffer pointing to external Mat data
    return ArrayBuffer::New(env, data, size, deleter<cv::Mat>, ref);
#endif
  }
}

class FrameObject : public CoreObject<FrameObject, Arv::Frame::Ptr> {
  CORE_OBJECT_DECL(FrameObject);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "Frame";
  static Function Init(Napi::Env env) {
    return DefineClass(env, FrameObject::name.c_str(),
                       {
                           CORE_OBJECT_REGISTER(FrameObject, env),  //
                           INSTANCE_METHOD(FrameObject, view),      //
                           INSTANCE_GETTER(FrameObject, width),     //
                           INSTANCE_GETTER(FrameObject, height),    //
                           INSTANCE_GETTER(FrameObject, timestamp), //
                       });
  }

  static std::string describe(const FrameObject *obj) {
    return obj->core()->tag;
  }

private:
  FN(view) {
    try {
      auto tag = core()->tag;
      auto fmt = core()->format;
      if (info.Length() > 0) {
        JS_ASSERT(info[0].IsString(), TypeError,
                  "Pixel format must be a string", env.Undefined());
        const auto arg = info[0].As<String>().Utf8Value();
        try {
          fmt = convert<Arv::PixelFormat>(arg);
        }
        JS_EXCEPT(env.Undefined())
      }
      const auto action =
          "Frame[" + tag + "].view(" + convert<std::string>(fmt) + ")";
      VERBOSE("[Requested] %s", action.c_str());
      auto container = info.Length() > 1 ? info[1] : env.Undefined();
      if (core()->isAvailable(fmt)) {
        // Resolve immediately if already available
        auto deferred = Promise::Deferred::New(env);
        deferred.Resolve(convert(env, container, core()->view(fmt)));
        VERBOSE("[Resolved] (cached) %s", action.c_str());
        return deferred.Promise();
      } else {
        // Launch one-shot async worker to convert
        auto task = [core = core(), fmt, action]() {
          VERBOSE("[Dispatched] %s", action.c_str());
          auto result = core->view(fmt);
          VERBOSE("[Completed] %s", action.c_str());
          return result;
        };
        return OneShotWorker<cv::Mat>::run(container, task);
      }
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(width) { return Number::New(env, core()->width()); }

  GET(height) { return Number::New(env, core()->height()); }

  GET(timestamp) { return BigInt::New(env, core()->timestamp); }
};

CORE_OBJECT(FrameObject);
