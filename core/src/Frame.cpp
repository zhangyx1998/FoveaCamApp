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
#include "napi-helper.h"

using namespace Napi;

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
      const auto fmt = optionalArgument(info[0], Arv::PixelFormat::BGRA8);
      const auto container = optionalArgument(info[1]);
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
};

CORE_OBJECT(FrameObject);
