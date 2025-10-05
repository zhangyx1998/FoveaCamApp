// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstring>

#include <Aravis/Frame.h>
#include <utils/map-set.h>

#include "CoreObject.h"
#include "napi-helper.h"

using namespace Napi;

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
    return obj->core()->tag();
  }

private:
  FN(view) {
    cv::Mat view;
    if (info.Length() > 0) {
      JS_ASSERT_RET(info[0].IsString(), TypeError,
                    "Pixel format must be a string", env.Undefined());
      const auto format = info[0].As<String>().Utf8Value();
      view = core()->view(format);
    } else {
      view = core()->raw;
    }
    const auto data = view.data;
    const auto size = view.size().area() * view.elemSize();
    if (info.Length() > 1) {
      ArrayBuffer buffer;
      if (info[1].IsArrayBuffer()) {
        buffer = info[1].As<ArrayBuffer>();
      } else if (info[1].IsTypedArray()) {
        buffer = info[1].As<TypedArray>().ArrayBuffer();
      } else if (info[1].IsDataView()) {
        buffer = info[1].As<DataView>().ArrayBuffer();
      } else {
        JS_THROW_RET(TypeError, "Destination cannot be casted into ArrayBuffer",
                     env.Undefined());
      }
      JS_ASSERT_RET(buffer.ByteLength() >= size, RangeError,
                    "Destination buffer size too small", env.Undefined());
      std::memcpy(buffer.Data(), data, size);
      return buffer;
    }
#ifdef V8_MEMORY_CAGE
    auto buffer = Napi::ArrayBuffer::New(env, size);
    std::memcpy(buffer.Data(), data, size);
    return buffer;
#else
    // Increment reference count on ImagePtr holding the buffer pointer
    auto ref = new cv::Mat(view);
    return Napi::ArrayBuffer::New(env, data, size, deleter<cv::Mat>, ref);
#endif
  }

  GET(width) { return Number::New(env, core()->width()); }

  GET(height) { return Number::New(env, core()->height()); }

  GET(timestamp) { return BigInt::New(env, core()->timestamp); }
};

CORE_OBJECT(Arv::Frame::Ptr, FrameObject);
