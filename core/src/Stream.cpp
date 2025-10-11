// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <cstddef>
#include <cstring>

#include <napi.h>

#include <Aravis/Camera.h>
#include <Aravis/Frame.h>
#include <Aravis/Stream.h>
#include <convert.h>

#include "CoreObject.h"
#include "Iterators.h"
#include "napi-helper.h"

using namespace Napi;

class StreamObject : public CoreObject<StreamObject, Arv::Stream::Ptr> {
  CORE_OBJECT_DECL(StreamObject);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "CameraStream";
  static inline Function Init(Napi::Env env) {
    auto iterator = Napi::Symbol::WellKnown(env, "iterator");
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    auto fn = DefineClass(
        env, StreamObject::name.c_str(),
        {
            CORE_OBJECT_REGISTER(StreamObject, env),                      //
            INSTANCE_GETTER(StreamObject, camera),                        //
            InstanceMethod<&StreamObject::iterator>(iterator),            //
            InstanceMethod<&StreamObject::async_iterator>(asyncIterator), //
        });
    return fn;
  }

  GET(camera) {
    auto env = info.Env();
    return CreateObject(env, core()->camera);
  }

  FN(iterator) {
    auto env = info.Env();
    return CreateObject(env, FrameLatest::create(env, core().get()));
  }

  FN(async_iterator) {
    auto env = info.Env();
    return CreateObject(env, FrameQueue::create(env, core().get()));
  }

  // TODO
  // GET(active) {}
  // SET(active) {}
};

CORE_OBJECT(Arv::Stream::Ptr, StreamObject);
