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
#include "napi-helper.h"

using namespace Napi;

#define GET_PROP(prop, JsType, ...)                                            \
  GET(prop) {                                                                  \
    JS_EXCEPT(return JsType::New(env, __VA_ARGS__(core()->get_##prop())),      \
                     env.Undefined())                                          \
  }

#define SET_PROP(Prop, Value, ...)                                             \
  SET(Prop) { JS_EXCEPT(core()->set_##Prop(__VA_ARGS__(Value));) }

#define RANGE(name)                                                            \
  GET(name##_range) {                                                          \
    JS_EXCEPT(                                                                 \
        {                                                                      \
          auto range = core()->get_##name##_range();                           \
          auto obj = Napi::Object::New(env);                                   \
          obj.Set("min", Number::New(env, range.min));                         \
          obj.Set("max", Number::New(env, range.max));                         \
          return obj;                                                          \
        },                                                                     \
        env.Undefined());                                                      \
  }

#define OPTIONS(name)                                                          \
  GET(name##_options) {                                                        \
    JS_EXCEPT(                                                                 \
        {                                                                      \
          auto options = core()->get_##name##_options();                       \
          auto ret = Array::New(env, options.size());                          \
          for (size_t i = 0; i < options.size(); ++i)                          \
            ret.Set(i, String::New(env, options[i]));                          \
          return ret;                                                          \
        },                                                                     \
        env.Undefined());                                                      \
  }

class CameraObject : public CoreObject<CameraObject, Arv::Camera::Ptr> {
  CORE_OBJECT_DECL(CameraObject);

public:
  using CoreObject::CoreObject;
  static inline const std::string name = "Camera";
  static Function Init(Napi::Env env) {
    auto fn = DefineClass(
        env, CameraObject::name.c_str(),
        {
            CORE_OBJECT_REGISTER(CameraObject, env),                   //
            INSTANCE_METHOD(CameraObject, grab),                       //
            INSTANCE_GETTER(CameraObject, stream),                     //
            INSTANCE_GETTER(CameraObject, physical_id),                //
            INSTANCE_GETTER(CameraObject, device_id),                  //
            INSTANCE_GETTER(CameraObject, vendor),                     //
            INSTANCE_GETTER(CameraObject, model),                      //
            INSTANCE_GETTER(CameraObject, serial),                     //
            INSTANCE_ACCESSOR(CameraObject, acquisition_mode),         //
            INSTANCE_ACCESSOR(CameraObject, frame_count),              //
            INSTANCE_GETTER(CameraObject, frame_count_range),          //
            INSTANCE_ACCESSOR(CameraObject, frame_rate_enable),        //
            INSTANCE_GETTER(CameraObject, frame_rate_available),       //
            INSTANCE_ACCESSOR(CameraObject, frame_rate),               //
            INSTANCE_GETTER(CameraObject, frame_rate_range),           //
            INSTANCE_METHOD(CameraObject, setTrigger),                 //
            INSTANCE_GETTER(CameraObject, trigger_options),            //
            INSTANCE_METHOD(CameraObject, clearTriggers),              //
            INSTANCE_METHOD(CameraObject, softwareTrigger),            //
            INSTANCE_ACCESSOR(CameraObject, trigger_source),           //
            INSTANCE_GETTER(CameraObject, trigger_source_options),     //
            INSTANCE_GETTER(CameraObject, exposure_time_available),    //
            INSTANCE_GETTER(CameraObject, exposure_auto_available),    //
            INSTANCE_ACCESSOR(CameraObject, exposure),                 //
            INSTANCE_GETTER(CameraObject, exposure_range),             //
            INSTANCE_ACCESSOR(CameraObject, exposure_auto),            //
            INSTANCE_METHOD(CameraObject, setExposureMode),            //
            INSTANCE_GETTER(CameraObject, gain_available),             //
            INSTANCE_GETTER(CameraObject, gain_auto_available),        //
            INSTANCE_METHOD(CameraObject, selectGain),                 //
            INSTANCE_GETTER(CameraObject, gain_options),               //
            INSTANCE_ACCESSOR(CameraObject, gain),                     //
            INSTANCE_GETTER(CameraObject, gain_range),                 //
            INSTANCE_ACCESSOR(CameraObject, gain_auto),                //
            INSTANCE_GETTER(CameraObject, black_level_available),      //
            INSTANCE_GETTER(CameraObject, black_level_auto_available), //
            INSTANCE_METHOD(CameraObject, selectBlackLevel),           //
            INSTANCE_GETTER(CameraObject, black_level_options),        //
            INSTANCE_ACCESSOR(CameraObject, black_level),              //
            INSTANCE_GETTER(CameraObject, black_level_range),          //
            INSTANCE_ACCESSOR(CameraObject, black_level_auto),         //
        });
    fn.Set("list", Function::New(env, list, "list"));
    return fn;
  }

  static std::string describe(const CameraObject *obj) {
    return obj->core()->tag;
  }

private:
  using Cameras = std::vector<Arv::Camera::Ptr>;
  static FN(list) {
    return OneShotWorker<Cameras>::run(info.Env(), Arv::Camera::list);
  }

  FN(grab) {
    const auto timeout = info.Length() > 0 && info[0].IsNumber()
                             ? info[0].As<Number>().Int32Value()
                             : 0;
    auto task = [core = core(), timeout]() { return core->grab(timeout); };
    return OneShotWorker<Arv::Frame::Ptr>::run(env, task);
  }

  GET(stream) { return CreateObject(env, Arv::Stream::get(core())); }

  GET_PROP(physical_id, String);
  GET_PROP(device_id, String);
  GET_PROP(vendor, String);
  GET_PROP(model, String);
  GET_PROP(serial, String);

  GET_PROP(acquisition_mode, String,
           (convert<std::string, ArvAcquisitionMode>));
  SET_PROP(acquisition_mode, val.ToString().Utf8Value(),
           (convert<ArvAcquisitionMode, std::string>));

  GET_PROP(frame_count, Number);
  SET_PROP(frame_count, val.As<Number>().Int64Value());
  RANGE(frame_count);

  GET_PROP(frame_rate_enable, Boolean);
  SET_PROP(frame_rate_enable, val.As<Boolean>().Value());
  GET_PROP(frame_rate_available, Boolean);

  GET_PROP(frame_rate, Number);
  SET_PROP(frame_rate, val.As<Number>().DoubleValue());
  RANGE(frame_rate);

  FN(setTrigger) {
    JS_EXCEPT(
        {
          auto mode = info[0].As<String>().Utf8Value();
          core()->set_trigger(mode.c_str());
          return Boolean::New(env, true);
        },
        Boolean::New(env, false));
  }
  OPTIONS(trigger);

  FN(clearTriggers) {
    JS_EXCEPT(
        {
          core()->clear_triggers();
          return env.Undefined();
        },
        env.Undefined());
  }

  FN(softwareTrigger) {
    JS_EXCEPT(
        {
          core()->software_trigger();
          return env.Undefined();
        },
        env.Undefined());
  }

  SET_PROP(trigger_source, val.As<String>().Utf8Value(),
           (convert<const char *, std::string>));
  GET_PROP(trigger_source, String);
  OPTIONS(trigger_source)

  GET_PROP(exposure_time_available, Boolean);
  GET_PROP(exposure_auto_available, Boolean);

  GET_PROP(exposure, Number);

  SET_PROP(exposure, val.As<Number>().DoubleValue());
  RANGE(exposure);

  GET_PROP(exposure_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(exposure_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));

  FN(setExposureMode) {
    JS_EXCEPT(
        {
          auto mode = info[0].As<String>().Utf8Value();
          core()->set_exposure_mode(convert<ArvExposureMode>(mode));
          return Boolean::New(env, true);
        },
        Boolean::New(env, false));
  }

  /* Analog control */

  GET_PROP(gain_available, Boolean);
  GET_PROP(gain_auto_available, Boolean);
  FN(selectGain) {
    JS_EXCEPT(
        {
          auto selector = info[0].As<String>().Utf8Value();
          core()->select_gain(selector.c_str());
          return Boolean::New(env, true);
        },
        Boolean::New(env, false));
  }
  OPTIONS(gain)

  GET_PROP(gain, Number);
  SET_PROP(gain, val.As<Number>().DoubleValue());
  RANGE(gain);
  GET_PROP(gain_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(gain_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));

  GET_PROP(black_level_available, Boolean);
  GET_PROP(black_level_auto_available, Boolean);
  FN(selectBlackLevel) {
    JS_EXCEPT(
        {
          auto selector = info[0].As<String>().Utf8Value();
          core()->select_black_level(selector.c_str());
          return Boolean::New(env, true);
        },
        Boolean::New(env, false));
  }
  OPTIONS(black_level)

  GET_PROP(black_level, Number);
  SET_PROP(black_level, val.As<Number>().DoubleValue());
  RANGE(black_level);

  GET_PROP(black_level_auto, String, (convert<std::string, ArvAuto>));
  SET_PROP(black_level_auto, val.As<String>().Utf8Value(),
           (convert<ArvAuto, std::string>));
};

CORE_OBJECT(Arv::Camera::Ptr, CameraObject);

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &container,
                    const CameraObject::Cameras &cameras) {
  auto array = Array::New(env, cameras.size());
  for (size_t i = 0; i < cameras.size(); ++i)
    array.Set(i, CameraObject::Create(env, cameras[i]));
  return array;
}
