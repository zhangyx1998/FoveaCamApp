// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <atomic>
#include <chrono>

#include <napi.h>
#include <opencv2/core.hpp>
#include <opencv2/tracking.hpp>

#include <Aravis/Stream.h>

#include "AsyncTask.h"
#include "CoreObject.h"
#include "Iterator.h"    // TransformStream, Sub::Queue/Iterator (async-generator seam)
#include "ThreadMeter.h" // C's standalone native meter (reused, not forked)
#include "napi-helper.h"

using namespace Napi;
using namespace cv;

// Always qualify `Napi::Object` in this TU: including the Aravis headers (via
// Iterator.h) pulls the global `Object` template into scope alongside
// `using namespace Napi` (same discipline as Camera.cpp).

// =====================================================================
// TrackerKCF CoreObject
// =====================================================================

struct TrackerUpdateResult {
  bool ok;
  cv::Rect bbox;
};

template <>
Napi::Value convert(Napi::Env env,
                    const TrackerUpdateResult &result) noexcept {
  if (!result.ok)
    return env.Null();
  return convert(env, result.bbox);
}

template <>
Napi::Value convert(Napi::Env env, const Napi::Value &,
                    const TrackerUpdateResult &result) noexcept {
  return convert(env, result);
}

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
                           INSTANCE_METHOD(TrackerKCFObject, updateAsync),
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

  FN(updateAsync) {
    auto env = info.Env();
    try {
      auto tracker = core();
      auto frame = convert<cv::Mat>(info[0]);
      return AsyncTask<TrackerUpdateResult>::run(
          env,
          [tracker, frame]() {
            cv::Rect bbox;
            bool ok = tracker->update(frame, bbox);
            return TrackerUpdateResult{ok, bbox};
          },
          "KCF.updateAsync");
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(TrackerKCFObject)

// =====================================================================
// WS1 1d — KCF tracker on its own free-running C++ thread (the milestone's
// second thread). A `TransformStream` whose base `Stream<TrackResult::Ptr>`
// thread pulls the LATEST center-camera frame (built-in `Sub::Latest`,
// latest-wins/drop-stale) and runs full-frame KCF OFF the JS event loop;
// results stream back to JS via the standard async-generator seam
// (`StreamObject`-style `Sub::Queue` iterator). Instrumented by C's
// `Meter::ThreadMeter` (single writer = the transform thread), probed
// out-of-loop. v1 = full-frame `update` — the JS search-window crop is a perf
// follow-up (port into `transform`), and v1 tracking cost/behavior wants rig
// confirmation (part of the milestone pass).
// =====================================================================

static int64_t nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}

struct TrackResult : Shared<TrackResult> {
  bool found = false;
  cv::Rect bbox;
  uint64_t seq = 0;             // result counter (transform thread)
  uint64_t deviceTimestamp = 0; // source frame's camera-clock stamp (correlation)
};

template <> Napi::Value convert(Napi::Env env, const TrackResult::Ptr &r) noexcept {
  if (!r)
    return env.Null();
  auto o = Napi::Object::New(env);
  o.Set("found", Napi::Boolean::New(env, r->found));
  o.Set("bbox", r->found ? convert(env, r->bbox) : env.Null());
  o.Set("seq", Napi::Number::New(env, static_cast<double>(r->seq)));
  o.Set("deviceTimestamp", convert(env, r->deviceTimestamp));
  return o;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &, const TrackResult::Ptr &r) noexcept {
  return convert(env, r);
}

class KcfTrackerStream
    : public TransformStream<Arv::Frame::Ptr, TrackResult::Ptr> {
public:
  using Ptr = std::shared_ptr<KcfTrackerStream>;
  static Ptr create(Arv::Stream::Ptr upstream) {
    return std::make_shared<KcfTrackerStream>(std::move(upstream));
  }
  explicit KcfTrackerStream(Arv::Stream::Ptr upstream)
      : upstream_(std::move(upstream)), tracker_(cv::TrackerKCF::create()),
        meter_("tracker:center", {"frame"}, {"track"}, nowMs()) {}
  // Stream requires shutdown() before the base is destroyed (joins the thread
  // before the derived vtable/tracker_ go away).
  ~KcfTrackerStream() override { shutdown(); }

  // Arm/re-arm: KCF (re-)inits on the next frame with `roi`. Callable from JS.
  void arm(const cv::Rect &roi) {
    *pending_.ref() = roi;
    hasPending_.store(true, std::memory_order_release);
  }
  Meter::Snapshot probe() const { return meter_.probe(nowMs()); }
  // Test hook: add `ms` of artificial per-frame work so the camera outruns the
  // transform, exercising the latest-wins drop counter / meter.drop path.
  void stall(double ms) { stallMs_.store(ms, std::memory_order_release); }

protected:
  Stream<Arv::Frame::Ptr> *upstream() override { return upstream_.get(); }

  TrackResult::Ptr transform(const Arv::Frame::Ptr &frame) override {
    const int64_t t = nowMs();
    // Meter frames the camera outran us (latest-wins overwrote them) — the
    // "KCF can't keep up" signal.
    const uint64_t drops = upstreamDrops();
    if (drops > lastDrops_) {
      meter_.drop(drops - lastDrops_);
      lastDrops_ = drops;
    }
    meter_.ingest("frame", t);

    const cv::Mat &gray = frame->raw; // center camera is Mono8 — track raw
    if (hasPending_.exchange(false, std::memory_order_acq_rel)) {
      tracker_->init(gray, *pending_.ref());
      armed_ = true;
      return nullptr; // the init frame yields no result
    }
    if (!armed_)
      return nullptr; // idle until armed

    meter_.begin(t);
    cv::Rect bbox;
    const bool ok = tracker_->update(gray, bbox);
    if (const double s = stallMs_.load(std::memory_order_acquire); s > 0)
      std::this_thread::sleep_for(std::chrono::duration<double, std::milli>(s));
    meter_.end(nowMs());

    auto result = TrackResult::create();
    result->found = ok;
    result->bbox = bbox;
    result->seq = ++produced_;
    result->deviceTimestamp = frame->device_timestamp;
    meter_.emit("track", nowMs());
    return result;
  }

private:
  Arv::Stream::Ptr upstream_;
  cv::Ptr<cv::TrackerKCF> tracker_; // transform-thread only
  Meter::ThreadMeter meter_;        // single writer = transform thread
  Threading::Guard<cv::Rect> pending_ = {cv::Rect()};
  std::atomic<bool> hasPending_{false};
  std::atomic<double> stallMs_{0}; // test-only induced slowness
  bool armed_ = false;    // transform-thread only
  uint64_t produced_ = 0; // transform-thread only
  uint64_t lastDrops_ = 0; // transform-thread only
};

static Napi::Object statsToJs(Napi::Env env,
                              const std::vector<std::pair<std::string, Meter::StreamStat>> &v) {
  auto m = Napi::Object::New(env);
  for (const auto &[k, st] : v) {
    auto so = Napi::Object::New(env);
    so.Set("count", Napi::Number::New(env, static_cast<double>(st.count)));
    so.Set("ratePerSec", Napi::Number::New(env, st.ratePerSec));
    so.Set("maxIntervalMs", Napi::Number::New(env, st.maxIntervalMs));
    m.Set(k, so);
  }
  return m;
}
static Napi::Value snapshotToJs(Napi::Env env, const Meter::Snapshot &s) {
  auto o = Napi::Object::New(env);
  o.Set("name", Napi::String::New(env, s.name));
  o.Set("uptimeMs", Napi::Number::New(env, static_cast<double>(s.uptimeMs)));
  o.Set("utilization", Napi::Number::New(env, s.utilization));
  o.Set("busyMs", Napi::Number::New(env, s.busyMs));
  o.Set("dropTotal", Napi::Number::New(env, static_cast<double>(s.dropTotal)));
  o.Set("inputs", statsToJs(env, s.inputs));
  o.Set("outputs", statsToJs(env, s.outputs));
  return o;
}

// CoreObject over a KcfTrackerStream: `arm(roi)`, `[Symbol.asyncIterator]`
// (a Sub::Queue on the tracker stream, exactly like StreamObject), and an
// out-of-loop `probe()` of the native meter. Create-only (via `createTracker`).
class KcfTrackerObject
    : public CoreObject<KcfTrackerObject, KcfTrackerStream::Ptr> {
public:
  // Exported as `KcfTracker` (not `Tracker`): the module is already named
  // `Tracker`, so a member named `Tracker` collides with the module name — the
  // generated `dist/Tracker/index.mjs` would `import { Tracker }` AND
  // `const { Tracker }`, a duplicate-declaration SyntaxError. `KcfTracker` also
  // mirrors this class and reads distinctly from the low-level `KCF` primitive.
  static inline const std::string name = "KcfTracker";
  static std::string describe(const KcfTrackerObject *) { return "KcfTracker"; }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(KcfTrackerObject, env),
            INSTANCE_METHOD(KcfTrackerObject, arm),
            INSTANCE_METHOD(KcfTrackerObject, probe),
            INSTANCE_METHOD(KcfTrackerObject, stall),
            Napi::InstanceWrap<KcfTrackerObject>::template InstanceMethod<
                &KcfTrackerObject::asyncIterator>(asyncIterator),
        });
  }

  CORE_OBJECT_DECL(KcfTrackerObject)

  KcfTrackerObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(arm) {
    auto env = info.Env();
    try {
      core()->arm(convert<cv::Rect>(info[0]));
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(probe) {
    auto env = info.Env();
    try {
      return snapshotToJs(env, core()->probe());
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(stall) {
    auto env = info.Env();
    try {
      core()->stall(info[0].As<Napi::Number>().DoubleValue());
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(asyncIterator) {
    auto env = info.Env();
    try {
      auto stream = core().get();
      auto queue = Sub::Queue<TrackResult::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<TrackResult::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(KcfTrackerObject)

// Factory: create a KCF tracker thread on a camera's shared Arv::Stream (the
// tracker's Sub::Latest is a co-subscriber alongside preview/vision — one pop,
// fan-out; Aravis exclusivity honored via the shared Stream::get).
static FN(createTracker) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    auto stream = KcfTrackerStream::create(Arv::Stream::get(camera));
    return KcfTrackerObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportTrackerNamespace(Napi::Env env, Napi::Object &exports) {
  TrackerKCFObject::Export(env, exports);
  KcfTrackerObject::Export(env, exports); // register the class for Create()
  EXPORT(exports, createTracker);
}
#undef EXPORT
