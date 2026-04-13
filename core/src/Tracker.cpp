// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <napi.h>
#include <opencv2/core.hpp>
#include <opencv2/tracking.hpp>

#include "CoreObject.h"
#include "napi-helper.h"

using namespace Napi;
using namespace cv;

// =====================================================================
// TrackerKCF CoreObject
// =====================================================================

class TrackerKCFObject
    : public CoreObject<TrackerKCFObject, cv::Ptr<cv::TrackerKCF>> {
public:
  static inline const std::string name = "KCF";

  static std::string describe(const TrackerKCFObject *) { return "KCF"; }

  static Core ConstructFromJS(const Napi::CallbackInfo &info) {
    return cv::TrackerKCF::create();
  }

  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, name.c_str(),
                       {
                           CORE_OBJECT_REGISTER(TrackerKCFObject, env),
                           INSTANCE_METHOD(TrackerKCFObject, init),
                           INSTANCE_METHOD(TrackerKCFObject, update),
                       });
  }

  CORE_OBJECT_DECL(TrackerKCFObject)

  TrackerKCFObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(init) {
    auto env = info.Env();
    try {
      auto frame = convert<cv::Mat>(info[0]);
      auto roi = convert<cv::Rect>(info[1]);
      core()->init(frame, roi);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(update) {
    auto env = info.Env();
    try {
      auto frame = convert<cv::Mat>(info[0]);
      cv::Rect bbox;
      bool ok = core()->update(frame, bbox);
      if (!ok)
        return env.Null();
      return convert(env, bbox);
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(TrackerKCFObject)

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportTrackerNamespace(Napi::Env env, Napi::Object &exports) {
  TrackerKCFObject::Export(env, exports);
}
#undef EXPORT
