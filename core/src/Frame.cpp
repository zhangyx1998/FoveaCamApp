// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstring>

#include <Aravis/Frame.h>
#include <utils/map-set.h>

#include "Buffer/Buffer.h"
#include "CoreObject.h"
#include "napi-helper.h"

using namespace Napi;

template <> Value convert(Env env, const Value &container, const cv::Mat &mat) {
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
    auto fmt = core()->format;
    if (info.Length() > 0) {
      JS_ASSERT(info[0].IsString(), TypeError, "Pixel format must be a string",
                env.Undefined());
      const auto format = info[0].As<String>().Utf8Value();
      JS_EXCEPT({ fmt = convert<Arv::PixelFormat>(format); }, env.Undefined());
    }
    auto container = info.Length() > 1 ? info[1] : env.Undefined();
    if (core()->isAvailable(fmt)) {
      // Resolve immediately if already available
      auto deferred = Promise::Deferred::New(env);
      JS_EXCEPT(
          {
            deferred.Resolve(convert(env, container, core()->view(fmt)));
            return deferred.Promise();
          },
          env.Undefined());
    } else {
      // Launch one-shot async worker to convert
      auto task = [core = core(), fmt]() { return core->view(fmt); };
      return OneShotWorker<cv::Mat>::run(container, task);
    }
  }

  GET(width) { return Number::New(env, core()->width()); }

  GET(height) { return Number::New(env, core()->height()); }

  GET(timestamp) { return BigInt::New(env, core()->timestamp); }
};

CORE_OBJECT(Arv::Frame::Ptr, FrameObject);
