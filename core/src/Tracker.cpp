// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <atomic>
#include <chrono>
#include <string>
#include <vector>

#include <napi.h>
#include <opencv2/calib3d.hpp> // initUndistortRectifyMap (B-25 fused undistort)
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp> // remap
#include <opencv2/tracking.hpp>

#include <Aravis/Frame.h> // convertFrame (B-25 cal-mode source prep)
#include <Aravis/Stream.h>

#include "AsyncTask.h"
#include "CoreObject.h"
#include "Iterator.h"    // TransformStream, Sub::Queue/Iterator (async-generator seam)
#include "ThreadMeter.h" // C's standalone native meter (reused, not forked)
#include "Vision.h"      // CameraCalibration (B-25 plain-JSON calibration)
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
  // Optional `name` = the graph node id (B-24: meter names ARE node ids);
  // default keeps the legacy name (C-24 shims it).
  static Ptr create(Arv::Stream::Ptr upstream,
                    std::string name = "tracker:center") {
    return std::make_shared<KcfTrackerStream>(std::move(upstream),
                                              std::move(name));
  }
  explicit KcfTrackerStream(Arv::Stream::Ptr upstream,
                            std::string name = "tracker:center")
      : upstream_(std::move(upstream)), tracker_(cv::TrackerKCF::create()),
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {}
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
      // Frame-bound clamp: an out-of-frame roi makes cv::TrackerKCF throw on
      // its empty internal patch (B-25 finding — same guard as MultiKcf).
      const cv::Rect roi =
          *pending_.ref() & cv::Rect(0, 0, gray.cols, gray.rows);
      if (roi.width >= 4 && roi.height >= 4) {
        tracker_->init(gray, roi);
        armed_ = true;
      }
      return nullptr; // the init frame yields no result
    }
    if (!armed_)
      return nullptr; // idle until armed

    meter_.begin(t);
    cv::Rect bbox;
    bool ok = false;
    try {
      ok = tracker_->update(gray, bbox);
    } catch (const std::exception &) {
      ok = false; // lost: KCF throws on a degenerate (edge-drifted) patch
    }
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
    // Optional info[1]: the graph node id — becomes the meter/probe name
    // (B-24; defaults to the legacy "tracker:center").
    auto stream = info.Length() >= 2 && info[1].IsString()
                      ? KcfTrackerStream::create(
                            Arv::Stream::get(camera),
                            info[1].As<Napi::String>().Utf8Value())
                      : KcfTrackerStream::create(Arv::Stream::get(camera));
    return KcfTrackerObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

// =====================================================================
// real-2 B-25 — multi-target KCF on ONE C++ thread (the last on-loop vision:
// multi-fovea's JS `runtime.onCenterFrame` KCF). Shape (c): one node, one
// batched output stream — up to MAX_TARGETS independent cv::TrackerKCF
// instances updated sequentially per frame, results per-frame-coherent
// ({seq, deviceTimestamp, targets:[{id, bbox|null, ok, updateMs}]}).
// Coordinate space (ii): with a calibration (plain persisted JSON) the thread
// FUSES the undistort — convert→full-frame remap with attach-time maps — so
// bboxes are in UNDISTORTED coordinates (what multi-fovea's pose math
// expects, no JS re-mapping). cal omitted = RAW mode (parity with
// KcfTrackerStream; its future migration path). NOTE: the per-target map-ROI
// window remap does NOT compose with cv::TrackerKCF (opaque learned state is
// pinned to its init coordinate frame; re-init per frame degrades to
// frame-pair template matching) — the union-of-patches remap into a
// persistent buffer is a GUARDED optimization behind the meter, not v1.
// Lost policy stays JS (we emit ok:false; lostTolerance is app policy).
// =====================================================================

struct MultiTrackTarget {
  std::string id;
  bool ok = false;
  cv::Rect bbox;
  double updateMs = 0;
};

struct MultiTrackResult : Shared<MultiTrackResult> {
  uint64_t seq = 0;
  uint64_t deviceTimestamp = 0;
  std::vector<MultiTrackTarget> targets;
};

template <>
Napi::Value convert(Napi::Env env, const MultiTrackResult::Ptr &r) noexcept {
  if (!r)
    return env.Null();
  auto o = Napi::Object::New(env);
  o.Set("seq", Napi::Number::New(env, static_cast<double>(r->seq)));
  o.Set("deviceTimestamp", convert(env, r->deviceTimestamp));
  auto arr = Napi::Array::New(env, r->targets.size());
  for (size_t i = 0; i < r->targets.size(); i++) {
    const auto &t = r->targets[i];
    auto to = Napi::Object::New(env);
    to.Set("id", Napi::String::New(env, t.id));
    to.Set("ok", Napi::Boolean::New(env, t.ok));
    to.Set("bbox", t.ok ? convert(env, t.bbox) : env.Null());
    to.Set("updateMs", Napi::Number::New(env, t.updateMs));
    arr.Set(static_cast<uint32_t>(i), to);
  }
  o.Set("targets", arr);
  return o;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &,
                    const MultiTrackResult::Ptr &r) noexcept {
  return convert(env, r);
}

class MultiKcfStream
    : public TransformStream<Arv::Frame::Ptr, MultiTrackResult::Ptr> {
public:
  using Ptr = std::shared_ptr<MultiKcfStream>;
  static constexpr size_t MAX_TARGETS = 8; // = MAX_MULTI_FOVEA_TARGETS

  // Per-target status snapshot for probe() (NAPI thread reads a copy).
  struct TargetStatus {
    std::string id;
    bool ok = false;
    cv::Rect bbox;
    double updateMs = 0;
    int64_t armedAtMs = 0;
  };

  // `name` = the graph node id, supplied by JS from C-24's graph-contract
  // builders (single spelling source — NEVER hardcoded here); `cal` nullable.
  static Ptr create(Arv::Stream::Ptr upstream, std::string name,
                    const CameraCalibration::Ptr &cal) {
    return std::make_shared<MultiKcfStream>(std::move(upstream),
                                            std::move(name), cal);
  }
  MultiKcfStream(Arv::Stream::Ptr upstream, std::string name,
                 const CameraCalibration::Ptr &cal)
      : upstream_(std::move(upstream)),
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {
    if (cal) { // sync map build at create (B-23 ruling #4 precedent)
      const auto &mtx = cal->camera_matrix;
      cv::initUndistortRectifyMap(mtx, cal->dist_coeffs, {}, mtx,
                                  cal->sensor_size, CV_32FC1, map1_, map2_);
    }
  }
  ~MultiKcfStream() override { shutdown(); }

  // Runtime churn (multi-fovea per-interaction): applied at the next frame.
  // Re-arm of a live id re-inits its tracker (the recenter case). An arm for
  // a NEW id beyond MAX_TARGETS is dropped (JS enforces its own cap).
  void arm(const std::string &id, const cv::Rect &roi) {
    pending_.ref()->push_back({true, id, roi});
    hasPending_.store(true, std::memory_order_release);
  }
  void disarm(const std::string &id) {
    pending_.ref()->push_back({false, id, cv::Rect()});
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(nowMs()); }
  std::vector<TargetStatus> targetStatus() { return *status_.ref(); }
  bool undistorted() const { return !map1_.empty(); }
  // Test hook (same as KcfTrackerStream): induced per-frame slowness so the
  // camera outruns us deterministically (drop-metering assertions).
  void stall(double ms) { stallMs_.store(ms, std::memory_order_release); }

protected:
  Stream<Arv::Frame::Ptr> *upstream() override { return upstream_.get(); }

  MultiTrackResult::Ptr transform(const Arv::Frame::Ptr &frame) override {
    const int64_t t = nowMs();
    const uint64_t drops = upstreamDrops();
    if (drops > lastDrops_) {
      meter_.drop(drops - lastDrops_);
      lastDrops_ = drops;
    }
    meter_.ingest("frame", t);

    // Apply queued arm/disarm ops (NAPI thread → this thread handoff).
    if (hasPending_.exchange(false, std::memory_order_acq_rel)) {
      std::vector<PendingOp> ops;
      pending_.ref()->swap(ops);
      for (auto &op : ops) {
        auto it = std::find_if(slots_.begin(), slots_.end(),
                               [&](const Slot &s) { return s.id == op.id; });
        if (op.armOp) {
          if (it == slots_.end()) {
            if (slots_.size() >= MAX_TARGETS)
              continue; // beyond cap — dropped (JS enforces its own)
            slots_.push_back(Slot{op.id});
            it = std::prev(slots_.end());
          }
          it->tracker = cv::TrackerKCF::create(); // (re-)init on this frame
          it->initRoi = op.roi;
          it->needsInit = true;
          it->armedAtMs = t;
        } else if (it != slots_.end()) {
          slots_.erase(it);
        }
      }
    }
    if (slots_.empty()) {
      status_.ref()->clear();
      return nullptr; // idle until armed (stream parks on zero subscribers)
    }

    meter_.begin(t);
    // Source prep — (ii) fused undistort: convert to Mono8 then full-frame
    // remap through the attach-time maps ⇒ ALL bboxes are undistorted-frame
    // coordinates. Raw mode tracks frame->raw directly (KcfTrackerStream
    // parity). One remap shared by all N targets.
    const cv::Mat *mat = &frame->raw;
    if (undistorted()) {
      Arv::convertFrame(frame->raw, frame->format, Arv::Mono8, tmp_);
      if (tmp_.size() != map1_.size()) { // geometry guard (ROI/binning change)
        meter_.end(nowMs());
        return nullptr;
      }
      cv::remap(tmp_, und_, map1_, map2_, cv::INTER_LINEAR);
      mat = &und_;
    }

    auto result = MultiTrackResult::create();
    result->targets.reserve(slots_.size());
    const cv::Rect frameRect(0, 0, mat->cols, mat->rows);
    for (auto &s : slots_) {
      const auto u0 = std::chrono::steady_clock::now();
      MultiTrackTarget out;
      out.id = s.id;
      // cv::TrackerKCF THROWS on degenerate patches (a bbox that drifted to
      // the frame edge yields an empty internal matrix). Treat any throw as
      // ok=false — the correct "lost" signal (JS lostTolerance owns policy);
      // an uncaught throw would crash the stream loop.
      try {
        if (s.needsInit) {
          const cv::Rect roi = s.initRoi & frameRect; // frame-bound clamp
          if (roi.width < 4 || roi.height < 4)
            throw std::invalid_argument("roi outside frame");
          s.tracker->init(*mat, roi);
          s.needsInit = false;
          out.ok = true; // the init frame reports the armed roi itself
          out.bbox = roi;
        } else {
          cv::Rect bbox;
          out.ok = s.tracker->update(*mat, bbox);
          out.bbox = bbox;
        }
      } catch (const std::exception &) {
        out.ok = false; // lost (degenerate patch / roi out of frame)
      }
      out.updateMs = std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - u0)
                         .count();
      s.lastOk = out.ok;
      s.lastBbox = out.bbox;
      s.lastUpdateMs = out.updateMs;
      result->targets.push_back(std::move(out));
    }
    if (const double sl = stallMs_.load(std::memory_order_acquire); sl > 0)
      std::this_thread::sleep_for(
          std::chrono::duration<double, std::milli>(sl));
    meter_.end(nowMs());

    { // per-target probe surface (small copy under the guard, once per frame)
      auto st = status_.ref();
      st->clear();
      for (const auto &s : slots_)
        st->push_back(
            {s.id, s.lastOk, s.lastBbox, s.lastUpdateMs, s.armedAtMs});
    }
    result->seq = ++produced_;
    result->deviceTimestamp = frame->device_timestamp;
    meter_.emit("track", nowMs());
    return result; // a batch EVERY frame while ≥1 target armed (ruling #4)
  }

private:
  struct Slot { // transform-thread only
    std::string id;
    cv::Ptr<cv::TrackerKCF> tracker;
    cv::Rect initRoi;
    bool needsInit = true;
    int64_t armedAtMs = 0;
    bool lastOk = false;
    cv::Rect lastBbox;
    double lastUpdateMs = 0;
  };
  struct PendingOp {
    bool armOp;
    std::string id;
    cv::Rect roi;
  };

  Arv::Stream::Ptr upstream_;
  Meter::ThreadMeter meter_; // single writer = transform thread
  cv::Mat map1_, map2_;      // full maps (empty ⇒ raw mode)
  cv::Mat tmp_, und_;        // reused convert/remap buffers (transform thread)
  std::vector<Slot> slots_;  // transform-thread only (≤ MAX_TARGETS)
  Threading::Guard<std::vector<PendingOp>> pending_;
  std::atomic<bool> hasPending_{false};
  Threading::Guard<std::vector<TargetStatus>> status_;
  std::atomic<double> stallMs_{0}; // test-only induced slowness
  uint64_t produced_ = 0;          // transform-thread only
  uint64_t lastDrops_ = 0;         // transform-thread only
};

// CoreObject over a MultiKcfStream: `arm(id, rect)` / `disarm(id)` /
// `probe()` (aggregate meter + per-target block) / `[Symbol.asyncIterator]`
// (batched results). Create-only via `createMultiTracker`.
class MultiKcfObject
    : public CoreObject<MultiKcfObject, MultiKcfStream::Ptr> {
public:
  static inline const std::string name = "MultiKcfTracker";
  static std::string describe(const MultiKcfObject *) {
    return "MultiKcfTracker";
  }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(MultiKcfObject, env),
            INSTANCE_METHOD(MultiKcfObject, arm),
            INSTANCE_METHOD(MultiKcfObject, disarm),
            INSTANCE_METHOD(MultiKcfObject, probe),
            INSTANCE_METHOD(MultiKcfObject, stall),
            Napi::InstanceWrap<MultiKcfObject>::template InstanceMethod<
                &MultiKcfObject::asyncIterator>(asyncIterator),
        });
  }

  CORE_OBJECT_DECL(MultiKcfObject)

  MultiKcfObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(arm) {
    auto env = info.Env();
    try {
      core()->arm(info[0].As<Napi::String>().Utf8Value(),
                  convert<cv::Rect>(info[1]));
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(disarm) {
    auto env = info.Env();
    try {
      core()->disarm(info[0].As<Napi::String>().Utf8Value());
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  FN(probe) {
    auto env = info.Env();
    try {
      auto o = snapshotToJs(env, core()->probe()).As<Napi::Object>();
      const auto st = core()->targetStatus();
      auto arr = Napi::Array::New(env, st.size());
      const int64_t now = nowMs();
      for (size_t i = 0; i < st.size(); i++) {
        auto to = Napi::Object::New(env);
        to.Set("id", Napi::String::New(env, st[i].id));
        to.Set("ok", Napi::Boolean::New(env, st[i].ok));
        to.Set("bbox", st[i].ok ? convert(env, st[i].bbox) : env.Null());
        to.Set("updateMs", Napi::Number::New(env, st[i].updateMs));
        to.Set("ageMs", Napi::Number::New(
                            env, static_cast<double>(now - st[i].armedAtMs)));
        arr.Set(static_cast<uint32_t>(i), to);
      }
      o.Set("targets", arr);
      o.Set("undistorted", Napi::Boolean::New(env, core()->undistorted()));
      return o;
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
      auto queue = Sub::Queue<MultiTrackResult::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<MultiTrackResult::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }
};

CORE_OBJECT(MultiKcfObject)

// Factory: `createMultiTracker(camera, {cal?, name?})` — symmetric with
// `createTracker`. `cal` = the plain persisted CameraCalibration JSON
// (⇒ undistorted-coordinate tracking); `name` = the graph node id from C's
// graph-contract builders (default legacy-safe).
static FN(createMultiTracker) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    std::string name = "tracker:multi";
    CameraCalibration::Ptr cal = nullptr;
    if (info.Length() >= 2 && info[1].IsObject()) {
      const auto opts = info[1].As<Napi::Object>();
      if (opts.Has("name") && opts.Get("name").IsString())
        name = opts.Get("name").As<Napi::String>().Utf8Value();
      if (opts.Has("cal") && !opts.Get("cal").IsUndefined() &&
          !opts.Get("cal").IsNull())
        cal = convert<CameraCalibration::Ptr>(opts.Get("cal"));
    }
    auto stream = MultiKcfStream::create(Arv::Stream::get(camera),
                                         std::move(name), cal);
    return MultiKcfObject::Create(env, stream);
  }
  JS_EXCEPT(env.Undefined())
}

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportTrackerNamespace(Napi::Env env, Napi::Object &exports) {
  TrackerKCFObject::Export(env, exports);
  KcfTrackerObject::Export(env, exports); // register the class for Create()
  MultiKcfObject::Export(env, exports);   // register the class for Create()
  EXPORT(exports, createTracker);
  EXPORT(exports, createMultiTracker);
}
#undef EXPORT
