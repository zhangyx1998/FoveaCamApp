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

#include "Aravis/ConverterStream.h" // OwnedFrame, ChainedStreamOf, findConverter
#include "Aravis/UndistortStream.h" // findUndistort (chained-tracker source)
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

// cv::TrackerKCF feature-set choice — BOTH knobs below are load-bearing on
// OpenCV 4.13.0; probes for each claim live in the 2026-07-10 fix commits.
//
// 1. GRAY features, not the default CN (Color Names): every camera here is
//    monochrome, so KCF only ever sees gray-replicated pixels. CN maps those
//    into a handful of achromatic color-name bins — on low-texture patches
//    (the rig's needle/target scenes, or ANY smooth gradient at the disparity
//    kernel's 64x64 arm size) the compressed CN response is degenerate: KCF
//    finds the target once (frame 2's patch still equals the model) and then
//    NEVER again. Symptom: box flashes once or never locks, UI parks on
//    "armed". GRAY features tracked these scenes for months pre-4.13.
// 2. desc_pca = GRAY **plus** desc_npca = GRAY, compressed_size = 1: the
//    obvious GRAY-only configs are BROKEN in 4.13.0 — {pca=GRAY, npca=0} and
//    {pca=0, npca=GRAY} both throw "Matrix operand is an empty matrix" on the
//    second update() (same empty-response bug family as CN-on-1ch). Listing
//    GRAY on BOTH descriptor slots with compressed_size=1 is the config that
//    survives; verified 29/29 sustained on 1ch AND 3ch input.
//
// Input depth/channels are normalized by `asColor8` (KCF's gray extractor
// only accepts 1- or 3-channel; the chained tap is 4-channel RGBA8).
static cv::Ptr<cv::TrackerKCF> makeKcf() {
  cv::TrackerKCF::Params p;
  p.desc_pca = cv::TrackerKCF::GRAY;
  p.desc_npca = cv::TrackerKCF::GRAY;
  p.compressed_size = 1;
  return cv::TrackerKCF::create(p);
}

// Normalize any tracker source frame to the 1-or-3-channel 8-bit layout
// cv::TrackerKCF accepts, reusing `buf`. 1ch passthrough would suffice for the
// GRAY features `makeKcf` pins, but the 4-channel chained tap MUST be reduced
// (KCF's gray extractor mishandles 4ch), and replicating 1ch → BGR keeps every
// variant on one proven path. Callers feed 8-bit frames (center cam is Mono8;
// the chained tap is RGBA8).
static const cv::Mat &asColor8(const cv::Mat &src, cv::Mat &buf) {
  switch (src.channels()) {
  case 1:
    cv::cvtColor(src, buf, cv::COLOR_GRAY2BGR);
    return buf;
  case 4:
    cv::cvtColor(src, buf, cv::COLOR_RGBA2BGR);
    return buf;
  default:
    return src; // already 3-channel
  }
}

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
    return makeKcf();
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
  // Bbox center (computed once in native — the value every consumer wants).
  // For an OVERRIDDEN result this is the override point (bbox may be a centered
  // box of the last armed size, or empty if never armed). Valid iff `found`.
  cv::Point2d center{0, 0};
  // True while the tracker is under a JS override (drag): KCF is NOT updated;
  // `center` is the override value. Flows downstream (matcher → PID) so each
  // stage acts correspondingly (controller-node-and-fifo-edges §3.5).
  bool overridden = false;
  uint64_t seq = 0;             // result counter (transform thread)
  uint64_t deviceTimestamp = 0; // source frame's camera-clock stamp (correlation)
};

template <> Napi::Value convert(Napi::Env env, const TrackResult::Ptr &r) noexcept {
  if (!r)
    return env.Null();
  auto o = Napi::Object::New(env);
  o.Set("found", Napi::Boolean::New(env, r->found));
  o.Set("bbox", r->found ? convert(env, r->bbox) : env.Null());
  o.Set("center", r->found ? convert(env, r->center) : env.Null());
  o.Set("overridden", Napi::Boolean::New(env, r->overridden));
  o.Set("seq", Napi::Number::New(env, static_cast<double>(r->seq)));
  o.Set("deviceTimestamp", convert(env, r->deviceTimestamp));
  return o;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &, const TrackResult::Ptr &r) noexcept {
  return convert(env, r);
}

// Per-frame engine verdict the state machine wraps into a TrackResult. `center`
// is authoritative when `found` (sub-pixel for the hybrid NCC engine; the
// bbox-center for KCF). Empty/unset when not found.
struct EngineResult {
  bool found = false;
  cv::Rect bbox;
  cv::Point2d center{0, 0};
};

// The tracking + override state machine, SHARED by the raw (camera-frame) and
// chained (OwnedFrame tap) variants AND by every tracking ENGINE (KCF, hybrid
// NCC): the arm/override/re-arm/produce logic lives here ONCE — an engine
// supplies only (re-)init + per-frame update via the two virtual hooks. All
// state is touched only on the owning stream's transform thread, except the
// atomic-flagged JS handoffs (arm / override / release), same discipline as the
// original `arm()`. NOTE (2026-07-10): extracted from the former monolithic
// `KcfCore` so the higher-fps hybrid tracker reuses the EXACT same state
// machine; KCF's observable behavior is unchanged (guarded by tests 12/21).
class TrackerCore {
public:
  virtual ~TrackerCore() = default;

  // Default roi size used when releasing an override with no prior arm.
  static constexpr int kDefaultOverrideRoi = 64;

  // JS-thread control surface (atomic slots applied on the next frame).
  void arm(const cv::Rect &roi) {
    *pending_.ref() = roi;
    hasPending_.store(true, std::memory_order_release);
  }
  void overrideCenter(const cv::Point2d &c) {
    *override_.ref() = c;
    overriding_.store(true, std::memory_order_release);
  }
  void releaseOverride() {
    // Only schedule a re-arm if we were actually engaged (idempotent release).
    if (overriding_.exchange(false, std::memory_order_acq_rel))
      wantRearm_.store(true, std::memory_order_release);
  }

  // Run one step on `src` (8-bit, 1/3/4 channel); transform-thread only. The
  // engine channel-normalizes `src` itself (KCF wants 3ch BGR, NCC wants 1ch
  // gray). Returns a result, or null for a frame that yields none (the (re-)init
  // frame). `meter` gets begin/end (busy) around engine work + emit("track") per
  // produced result; ingest/drop stay with the caller (they differ per variant).
  TrackResult::Ptr step(const cv::Mat &src, uint64_t deviceTimestamp,
                        Meter::ThreadMeter &meter, double stallMs) {
    const cv::Rect frameRect(0, 0, src.cols, src.rows);

    // Override RELEASE → schedule a re-arm at the last override center, sized
    // to the last armed roi (or the documented default if never armed).
    if (wantRearm_.exchange(false, std::memory_order_acq_rel)) {
      const cv::Point2d c = *override_.ref();
      const cv::Size sz = armedSize_.width > 0
                              ? armedSize_
                              : cv::Size(kDefaultOverrideRoi, kDefaultOverrideRoi);
      *pending_.ref() = centeredRect(c, sz);
      hasPending_.store(true, std::memory_order_release);
    }

    // Explicit (re-)arm request → engine init on this frame, no result emitted.
    if (hasPending_.exchange(false, std::memory_order_acq_rel)) {
      const cv::Rect roi = *pending_.ref() & frameRect; // frame-bound clamp
      if (roi.width >= 4 && roi.height >= 4) {
        armed_ = engineInit(src, roi); // engine reports (re-)init success
        if (armed_)
          armedSize_ = roi.size();
      }
      return nullptr;
    }

    // Override ENGAGED → emit the override center, DO NOT touch engine state.
    if (overriding_.load(std::memory_order_acquire)) {
      const cv::Point2d c = *override_.ref();
      auto result = TrackResult::create();
      result->found = true;
      result->overridden = true;
      result->center = c;
      // A centered box of the last armed size (empty if never armed).
      result->bbox = armedSize_.width > 0 ? centeredRect(c, armedSize_)
                                          : cv::Rect();
      result->seq = ++produced_;
      result->deviceTimestamp = deviceTimestamp;
      meter.emit("track", nowMs());
      return result;
    }

    if (!armed_)
      return nullptr; // idle until armed

    const int64_t t = nowMs();
    meter.begin(t);
    const EngineResult er = engineUpdate(src);
    if (stallMs > 0)
      std::this_thread::sleep_for(
          std::chrono::duration<double, std::milli>(stallMs));
    meter.end(nowMs());

    auto result = TrackResult::create();
    result->found = er.found;
    result->overridden = false;
    result->bbox = er.bbox;
    if (er.found)
      result->center = er.center;
    result->seq = ++produced_;
    result->deviceTimestamp = deviceTimestamp;
    meter.emit("track", nowMs());
    return result;
  }

protected:
  static cv::Rect centeredRect(const cv::Point2d &c, const cv::Size &sz) {
    return cv::Rect(cvRound(c.x - sz.width / 2.0), cvRound(c.y - sz.height / 2.0),
                    sz.width, sz.height);
  }

  // Engine hooks (transform-thread only). `engineInit` (re-)initializes on the
  // armed `roi` (already frame-bound-clamped, ≥4px) and returns false on a
  // degenerate init (state machine stays idle until re-armed). `engineUpdate`
  // runs one tracking step, returning the per-frame verdict.
  virtual bool engineInit(const cv::Mat &src, const cv::Rect &roi) = 0;
  virtual EngineResult engineUpdate(const cv::Mat &src) = 0;

private:
  Threading::Guard<cv::Rect> pending_ = {cv::Rect()};
  std::atomic<bool> hasPending_{false};
  Threading::Guard<cv::Point2d> override_ = {cv::Point2d(0, 0)};
  std::atomic<bool> overriding_{false};
  std::atomic<bool> wantRearm_{false};
  bool armed_ = false;           // transform-thread only
  cv::Size armedSize_{0, 0};     // last armed roi size (0 = never armed)
  uint64_t produced_ = 0;        // transform-thread only
};

// KCF engine: preserves the EXACT prior behavior (GRAY-features cv::TrackerKCF
// on a 3-channel BGR view; a throw on a degenerate patch is treated as lost /
// failed-init). Bbox center is the reported center.
class KcfCore : public TrackerCore {
protected:
  bool engineInit(const cv::Mat &src, const cv::Rect &roi) override {
    const cv::Mat &frame = asColor8(src, colorBuf_);
    try {
      tracker_->init(frame, roi);
      return true;
    } catch (const std::exception &) {
      return false; // degenerate init — stay idle until re-armed
    }
  }
  EngineResult engineUpdate(const cv::Mat &src) override {
    const cv::Mat &frame = asColor8(src, colorBuf_);
    EngineResult er;
    cv::Rect bbox;
    try {
      er.found = tracker_->update(frame, bbox);
    } catch (const std::exception &) {
      er.found = false; // lost: KCF throws on a degenerate (edge-drifted) patch
    }
    er.bbox = bbox;
    if (er.found)
      er.center = cv::Point2d(bbox.x + bbox.width / 2.0,
                              bbox.y + bbox.height / 2.0);
    return er;
  }

private:
  cv::Ptr<cv::TrackerKCF> tracker_ = makeKcf(); // GRAY-feature KCF; xform thread
  cv::Mat colorBuf_; // reused 3-channel BGR view for KCF (this thread)
};

// Abstract handle the JS CoreObject holds: BOTH tracker variants (raw camera
// stream + chained OwnedFrame tap) implement it, so one `KcfTrackerObject`
// surface (arm / override / release / probe / stall / async-iterate) drives
// either. Not a Stream itself (avoids a diamond) — `stream()` exposes the
// underlying `Stream<TrackResult::Ptr>` for the Sub::Queue iterator.
struct TrackerHandle {
  using Ptr = std::shared_ptr<TrackerHandle>;
  virtual ~TrackerHandle() = default;
  virtual void arm(const cv::Rect &roi) = 0;
  virtual void overrideCenter(const cv::Point2d &c) = 0;
  virtual void releaseOverride() = 0;
  virtual Meter::Snapshot probe() const = 0;
  virtual void stall(double ms) = 0;
  virtual Stream<TrackResult::Ptr> *stream() = 0;
};

class KcfTrackerStream
    : public TransformStream<Arv::Frame::Ptr, TrackResult::Ptr>,
      public TrackerHandle {
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
      : upstream_(std::move(upstream)),
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {}
  // Stream requires shutdown() before the base is destroyed (joins the thread
  // before the derived vtable/core_ go away).
  ~KcfTrackerStream() override { shutdown(); }

  // TrackerHandle surface (delegates the state machine to KcfCore).
  void arm(const cv::Rect &roi) override { core_.arm(roi); }
  void overrideCenter(const cv::Point2d &c) override { core_.overrideCenter(c); }
  void releaseOverride() override { core_.releaseOverride(); }
  Meter::Snapshot probe() const override { return meter_.probe(nowMs()); }
  // Test hook: add `ms` of artificial per-frame work so the camera outruns the
  // transform, exercising the latest-wins drop counter / meter.drop path.
  void stall(double ms) override { stallMs_.store(ms, std::memory_order_release); }
  Stream<TrackResult::Ptr> *stream() override { return this; }

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
    // Center camera is Mono8; KcfCore channel-normalizes it for
    // cv::TrackerKCF (see makeKcf/asColor8 for the 4.13 constraints).
    return core_.step(frame->raw, frame->device_timestamp, meter_,
                      stallMs_.load(std::memory_order_acquire));
  }

private:
  Arv::Stream::Ptr upstream_;
  Meter::ThreadMeter meter_; // single writer = transform thread
  KcfCore core_;             // tracking + override state machine
  std::atomic<double> stallMs_{0}; // test-only induced slowness
  uint64_t lastDrops_ = 0;   // transform-thread only
};

// CHAINED KCF variant (controller-node-and-fifo-edges §3.5): tracks another
// brick's OwnedFrame tap (the convert/undistort C view the disparity kernel
// sees) instead of the raw camera stream. Input channel = Leaky (latest-wins
// is right for a tracker — track the freshest frame; skips meter as drops).
// Reuses the exact same `KcfCore` loop; converts the BGRA/undistorted tap mat
// to gray as cv::TrackerKCF needs a single channel.
class ChainedKcfTrackerStream : public Arv::ChainedStreamOf<TrackResult::Ptr>,
                                public TrackerHandle {
public:
  using Ptr = std::shared_ptr<ChainedKcfTrackerStream>;
  static Ptr create(Source source, std::string name) {
    return std::make_shared<ChainedKcfTrackerStream>(std::move(source),
                                                     std::move(name));
  }
  ChainedKcfTrackerStream(Source source, std::string name)
      : Arv::ChainedStreamOf<TrackResult::Ptr>(std::move(source)), // Leaky
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {}
  ~ChainedKcfTrackerStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  void arm(const cv::Rect &roi) override { core_.arm(roi); }
  void overrideCenter(const cv::Point2d &c) override { core_.overrideCenter(c); }
  void releaseOverride() override { core_.releaseOverride(); }
  Meter::Snapshot probe() const override { return meter_.probe(nowMs()); }
  void stall(double ms) override { stallMs_.store(ms, std::memory_order_release); }
  Stream<TrackResult::Ptr> *stream() override { return this; }

protected:
  TrackResult::Ptr process(const Arv::OwnedFrame::Ptr &in) override {
    const int64_t t = nowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran us (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);
    // The tap carries honest RGBA8 (converted) or undistorted RGBA; KcfCore
    // channel-normalizes it for cv::TrackerKCF — its gray extractor mishandles
    // 4-channel input (see makeKcf/asColor8 for the 4.13 constraints).
    return core_.step(in->mat, in->deviceTimestamp, meter_,
                      stallMs_.load(std::memory_order_acquire));
  }

private:
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  KcfCore core_;             // tracking + override state machine (owns color buf)
  std::atomic<double> stallMs_{0}; // test-only induced slowness
};

// =====================================================================
// Higher-FPS HYBRID tracker (2026-07-10, user request): a drop-in replacement
// for the KCF tracker node that holds lock on this rig's hard MONO content (the
// needle/blob + low-texture scenes where GRAY-KCF collapses to a single-frame
// hit) AND runs faster. Engine = windowed NCC (cv::matchTemplate CCOEFF_NORMED,
// the SAME correlation the disparity matcher already trusts on these scenes),
// with a dual anchor/adaptive template (drift-proof) and an expanding-window
// ANCHOR re-detection ladder (KCF is silent-forever-lost; this RE-ACQUIRES).
// Single-scale (rig target scale is fovea-controlled); scale robustness is
// future work. Thresholds/rationale + the KCF-vs-hybrid bench live in
// docs/proposals/hybrid-tracker.md. Reuses TrackerCore's arm/override/re-arm
// state machine verbatim — only the two engine hooks differ.
// =====================================================================
class HybridCore : public TrackerCore {
public:
  // Tunables — validated in the C++ probe, locked in the proposal doc.
  // CCOEFF_NORMED scores are in [-1, 1].
  static constexpr double kTrackThresh = 0.45; // per-frame found gate
  static constexpr double kReacqThresh = 0.60; // recovery re-lock gate (> track: hysteresis)
  static constexpr double kAdaptAlpha = 0.05;  // adaptive template EMA rate
  static constexpr double kMotionMult = 3.0;   // search radius ≈ 3× recent per-frame motion
  static constexpr int kFullFrameLostStreak = 6; // escalate recovery to full frame
  static constexpr int kMaxRadius = 256;         // search radius cap (px)

protected:
  bool engineInit(const cv::Mat &src, const cv::Rect &roi) override {
    const cv::Mat &gray = toGray(src, grayBuf_);
    const cv::Rect r = roi & cv::Rect(0, 0, gray.cols, gray.rows);
    if (r.width < 4 || r.height < 4)
      return false;
    gray(r).copyTo(anchor_); // deep copy — owns memory (survives Frame release)
    anchor_.copyTo(adaptive_);
    tmpl_ = r.size();
    last_ = cv::Point2d(r.x + r.width / 2.0, r.y + r.height / 2.0);
    recentDisp_ = 0.0;
    lost_ = 0;
    return true;
  }

  EngineResult engineUpdate(const cv::Mat &src) override {
    const cv::Mat &gray = toGray(src, grayBuf_);
    EngineResult er;
    if (anchor_.empty())
      return er;

    // FAST PATH: dual-template NCC in a motion-adaptive window around `last_`.
    const cv::Rect win = windowAround(last_, searchRadius(), gray.size());
    if (win.width >= tmpl_.width && win.height >= tmpl_.height) {
      cv::matchTemplate(gray(win), adaptive_, mapAd_, cv::TM_CCOEFF_NORMED);
      cv::matchTemplate(gray(win), anchor_, mapAnc_, cv::TM_CCOEFF_NORMED);
      double adMax, ancMax;
      cv::Point adLoc, ancLoc;
      cv::minMaxLoc(mapAd_, nullptr, &adMax, nullptr, &adLoc);
      cv::minMaxLoc(mapAnc_, nullptr, &ancMax, nullptr, &ancLoc);
      // Report the argmax of max(anchor, adaptive) — the adaptive template
      // follows appearance change, the anchor guards against drift-onto-nothing.
      cv::Point loc;
      const cv::Mat *chosen;
      double score;
      if (adMax >= ancMax) { loc = adLoc; score = adMax; chosen = &mapAd_; }
      else { loc = ancLoc; score = ancMax; chosen = &mapAnc_; }
      if (score >= kTrackThresh) {
        const double dx = subpixel(*chosen, loc, true);
        const double dy = subpixel(*chosen, loc, false);
        const cv::Point2d c(win.x + loc.x + tmpl_.width / 2.0 + dx,
                            win.y + loc.y + tmpl_.height / 2.0 + dy);
        recentDisp_ = 0.7 * recentDisp_ + 0.3 * cv::norm(c - last_);
        last_ = c;
        lost_ = 0;
        er.found = true;
        er.center = c;
        er.bbox = centeredRect(c, tmpl_);
        // Drift-proof adaptive update: blend the fresh patch into the adaptive
        // template ONLY while the invariant ANCHOR still confirms this location
        // (its score at the chosen loc ≥ track threshold). If the anchor
        // disagrees we are likely drifting → freeze the adaptive template.
        if (mapAnc_.at<float>(loc) >= kTrackThresh) {
          const cv::Rect pr = centeredRect(c, tmpl_);
          if ((pr & cv::Rect(0, 0, gray.cols, gray.rows)) == pr)
            cv::addWeighted(adaptive_, 1.0 - kAdaptAlpha, gray(pr), kAdaptAlpha,
                            0.0, adaptive_);
        }
        return er;
      }
    }

    // RECOVERY: the "detection" half. Progressively widen an ANCHOR-only search
    // as the lost streak grows; at the top of the ladder scan the FULL frame at
    // half resolution (pyrDown) to bound cost. Re-lock only above the (higher)
    // re-acquire threshold — hysteresis so a marginal frame can't thrash lock.
    lost_++;
    cv::Point2d c;
    double score = 0;
    bool got = false;
    if (lost_ < kFullFrameLostStreak) {
      const int radius = tmpl_.width * (1 << std::min(lost_, 4)); // 2×,4×,8×…
      const cv::Rect w2 = windowAround(last_, radius, gray.size());
      if (w2.width >= tmpl_.width && w2.height >= tmpl_.height)
        got = peak(gray(w2), anchor_, w2.tl(), 1.0, c, score);
    } else {
      cv::pyrDown(gray, pyr_);
      cv::pyrDown(anchor_, anchorHalf_);
      got = peak(pyr_, anchorHalf_, cv::Point(0, 0), 2.0, c, score);
    }
    if (got && score >= kReacqThresh) {
      anchor_.copyTo(adaptive_); // reset the (possibly drifted) adaptive copy
      last_ = c;
      recentDisp_ = 0.0;
      lost_ = 0;
      er.found = true;
      er.center = c;
      er.bbox = centeredRect(c, tmpl_);
      return er;
    }

    // Still lost: report found:false, box parked on the last known center.
    er.found = false;
    er.center = last_;
    er.bbox = centeredRect(last_, tmpl_);
    return er;
  }

private:
  // Normalize any tracker source frame to 8-bit single-channel gray (NCC wants
  // one channel — matchTemplate would otherwise sum correlation over the
  // gray-replicated BGR/RGBA channels for no gain). Raw camera is Mono8
  // (passthrough); the chained tap is RGBA8. Reuses `buf`.
  static const cv::Mat &toGray(const cv::Mat &src, cv::Mat &buf) {
    switch (src.channels()) {
    case 1:
      return src; // Mono8 passthrough
    case 4:
      cv::cvtColor(src, buf, cv::COLOR_RGBA2GRAY);
      return buf;
    default:
      cv::cvtColor(src, buf, cv::COLOR_BGR2GRAY);
      return buf;
    }
  }

  // Search radius (px beyond the template half-extent): ≈ kMotionMult × recent
  // per-frame displacement, floored so the window is ≥ ~2× the template and
  // capped at kMaxRadius.
  int searchRadius() const {
    const int floorR = std::max(8, tmpl_.width / 2);
    int r = static_cast<int>(std::lround(kMotionMult * recentDisp_));
    return std::min(std::max(floorR, r), kMaxRadius);
  }

  // Frame-clamped search rect centered on `c`, half-extent = template/2 +
  // radius. May clamp smaller than the template near a border — the caller
  // guards (falls through to full-frame recovery).
  cv::Rect windowAround(const cv::Point2d &c, int radius,
                        const cv::Size &fs) const {
    const int hw = tmpl_.width / 2 + radius, hh = tmpl_.height / 2 + radius;
    cv::Rect w(cv::Point(static_cast<int>(std::lround(c.x)) - hw,
                         static_cast<int>(std::lround(c.y)) - hh),
               cv::Point(static_cast<int>(std::lround(c.x)) + hw,
                         static_cast<int>(std::lround(c.y)) + hh));
    return w & cv::Rect(0, 0, fs.width, fs.height);
  }

  // Parabolic sub-pixel peak offset (±1px, clamped) along one axis at `p` in the
  // CCOEFF_NORMED score map — smooth centers between integer correlation cells.
  static double subpixel(const cv::Mat &m, const cv::Point &p, bool horiz) {
    const int x = p.x, y = p.y;
    if (horiz) {
      if (x <= 0 || x >= m.cols - 1)
        return 0.0;
      const double l = m.at<float>(y, x - 1), c = m.at<float>(y, x),
                   r = m.at<float>(y, x + 1);
      const double d = l - 2 * c + r;
      if (std::abs(d) < 1e-9)
        return 0.0;
      return std::max(-1.0, std::min(1.0, 0.5 * (l - r) / d));
    }
    if (y <= 0 || y >= m.rows - 1)
      return 0.0;
    const double u = m.at<float>(y - 1, x), c = m.at<float>(y, x),
                 dn = m.at<float>(y + 1, x);
    const double d = u - 2 * c + dn;
    if (std::abs(d) < 1e-9)
      return 0.0;
    return std::max(-1.0, std::min(1.0, 0.5 * (u - dn) / d));
  }

  // Match `tmpl` in `sub`, returning the best center in FULL-frame coords via
  // `origin + scale` (scale > 1 maps a pyrDown sub-image back to full res).
  bool peak(const cv::Mat &sub, const cv::Mat &tmpl, const cv::Point &origin,
            double scale, cv::Point2d &center, double &score) {
    if (sub.cols < tmpl.cols || sub.rows < tmpl.rows)
      return false;
    cv::matchTemplate(sub, tmpl, mapRec_, cv::TM_CCOEFF_NORMED);
    double mx;
    cv::Point loc;
    cv::minMaxLoc(mapRec_, nullptr, &mx, nullptr, &loc);
    const double dx = subpixel(mapRec_, loc, true);
    const double dy = subpixel(mapRec_, loc, false);
    center.x = origin.x + (loc.x + tmpl.cols / 2.0 + dx) * scale;
    center.y = origin.y + (loc.y + tmpl.rows / 2.0 + dy) * scale;
    score = mx;
    return true;
  }

  cv::Mat anchor_;   // pristine template captured at arm (8UC1, owns memory)
  cv::Mat adaptive_; // slow-EMA template (anchor-confirmed updates only)
  cv::Size tmpl_{0, 0};        // template size (= armed roi size)
  cv::Point2d last_{0, 0};     // last known center (frame coords)
  double recentDisp_ = 0.0;    // EMA of per-frame displacement (adaptive window)
  int lost_ = 0;               // consecutive lost frames (recovery ladder)
  // Reused per-thread buffers (transform-thread only).
  cv::Mat grayBuf_, mapAd_, mapAnc_, mapRec_, pyr_, anchorHalf_;
};

// Raw HYBRID tracker on a camera's shared Arv::Stream — the drop-in twin of
// KcfTrackerStream (latest-wins Sub::Latest, same meter schema {frame}/{track},
// same TrackerHandle surface). Only the engine differs (HybridCore).
class HybridTrackerStream
    : public TransformStream<Arv::Frame::Ptr, TrackResult::Ptr>,
      public TrackerHandle {
public:
  using Ptr = std::shared_ptr<HybridTrackerStream>;
  static Ptr create(Arv::Stream::Ptr upstream,
                    std::string name = "tracker:center") {
    return std::make_shared<HybridTrackerStream>(std::move(upstream),
                                                 std::move(name));
  }
  explicit HybridTrackerStream(Arv::Stream::Ptr upstream,
                               std::string name = "tracker:center")
      : upstream_(std::move(upstream)),
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {}
  ~HybridTrackerStream() override { shutdown(); }

  void arm(const cv::Rect &roi) override { core_.arm(roi); }
  void overrideCenter(const cv::Point2d &c) override { core_.overrideCenter(c); }
  void releaseOverride() override { core_.releaseOverride(); }
  Meter::Snapshot probe() const override { return meter_.probe(nowMs()); }
  void stall(double ms) override { stallMs_.store(ms, std::memory_order_release); }
  Stream<TrackResult::Ptr> *stream() override { return this; }

protected:
  Stream<Arv::Frame::Ptr> *upstream() override { return upstream_.get(); }

  TrackResult::Ptr transform(const Arv::Frame::Ptr &frame) override {
    const int64_t t = nowMs();
    const uint64_t drops = upstreamDrops();
    if (drops > lastDrops_) {
      meter_.drop(drops - lastDrops_);
      lastDrops_ = drops;
    }
    meter_.ingest("frame", t);
    return core_.step(frame->raw, frame->device_timestamp, meter_,
                      stallMs_.load(std::memory_order_acquire));
  }

private:
  Arv::Stream::Ptr upstream_;
  Meter::ThreadMeter meter_; // single writer = transform thread
  HybridCore core_;          // NCC tracking + override state machine
  std::atomic<double> stallMs_{0}; // test-only induced slowness
  uint64_t lastDrops_ = 0;   // transform-thread only
};

// CHAINED HYBRID tracker on another brick's OwnedFrame tap — the drop-in twin
// of ChainedKcfTrackerStream. Teardown shape copied EXACTLY (closeChain() then
// shutdown() in the dtor; Leaky latest-wins input) — tests 36/38 guard it.
class ChainedHybridTrackerStream
    : public Arv::ChainedStreamOf<TrackResult::Ptr>,
      public TrackerHandle {
public:
  using Ptr = std::shared_ptr<ChainedHybridTrackerStream>;
  static Ptr create(Source source, std::string name) {
    return std::make_shared<ChainedHybridTrackerStream>(std::move(source),
                                                        std::move(name));
  }
  ChainedHybridTrackerStream(Source source, std::string name)
      : Arv::ChainedStreamOf<TrackResult::Ptr>(std::move(source)), // Leaky
        meter_(std::move(name), {"frame"}, {"track"}, nowMs()) {}
  ~ChainedHybridTrackerStream() override {
    closeChain(); // wake a blocked tap read (ChainedStream contract)
    shutdown();
  }

  void arm(const cv::Rect &roi) override { core_.arm(roi); }
  void overrideCenter(const cv::Point2d &c) override { core_.overrideCenter(c); }
  void releaseOverride() override { core_.releaseOverride(); }
  Meter::Snapshot probe() const override { return meter_.probe(nowMs()); }
  void stall(double ms) override { stallMs_.store(ms, std::memory_order_release); }
  Stream<TrackResult::Ptr> *stream() override { return this; }

protected:
  TrackResult::Ptr process(const Arv::OwnedFrame::Ptr &in) override {
    const int64_t t = nowMs();
    if (const uint64_t gap = seqGap(in)) // tap outran us (latest-wins)
      meter_.drop(gap);
    meter_.ingest("frame", t);
    return core_.step(in->mat, in->deviceTimestamp, meter_,
                      stallMs_.load(std::memory_order_acquire));
  }

private:
  Meter::ThreadMeter meter_; // single writer = this brick's thread
  HybridCore core_;          // NCC tracking + override state machine
  std::atomic<double> stallMs_{0}; // test-only induced slowness
};

// Shared full-schema serializer (window + drops + flat back-compat fields) —
// defined in core/lib/Aravis/ConverterStream.cpp; forward-declared like
// MarkerDetector.cpp does to avoid pulling the pipe headers into this TU.
// Tracker probes previously used a local flat copy WITHOUT `drops`, which
// crashed `perfSnapshot`'s graph fold the moment a tracker went live.
namespace Arv {
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);
}
static Napi::Value snapshotToJs(Napi::Env env, const Meter::Snapshot &s) {
  return Arv::meterSnapshotToJs(env, s);
}

// CoreObject over a TrackerHandle (raw OR chained variant): `arm(roi)`,
// `override({x,y})` / `releaseOverride()`, `[Symbol.asyncIterator]` (a
// Sub::Queue on the tracker stream, exactly like StreamObject), and an
// out-of-loop `probe()` of the native meter. Create-only (via `createTracker`
// / `createChainedTracker`).
class KcfTrackerObject
    : public CoreObject<KcfTrackerObject, TrackerHandle::Ptr> {
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
            INSTANCE_METHOD(KcfTrackerObject, releaseOverride),
            // `override` is a C++ keyword — register the C++ `overrideCenter`
            // under the JS name "override".
            Napi::InstanceWrap<KcfTrackerObject>::template InstanceMethod<
                &KcfTrackerObject::overrideCenter>("override"),
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
  // JS `override({x,y})` — engage a drag override: emit the override center,
  // skip KCF, flag results `overridden:true` until releaseOverride().
  FN(overrideCenter) {
    auto env = info.Env();
    try {
      core()->overrideCenter(convert<cv::Point2d>(info[0]));
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }
  // JS `releaseOverride()` — re-arm KCF at the last override center on the next
  // frame, then resume normal (non-overridden) results.
  FN(releaseOverride) {
    auto env = info.Env();
    try {
      core()->releaseOverride();
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
      auto stream = core()->stream();
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
    TrackerHandle::Ptr handle = std::move(stream);
    return KcfTrackerObject::Create(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// Factory: `createChainedTracker(sourcePipeId, name?)` — a KCF tracker on
// another brick's OwnedFrame tap (controller-node-and-fifo-edges §3.5), so it
// tracks EXACTLY the convert/undistort view the kernel sees. `sourcePipeId`
// resolves to a live convert brick (findConverter) or undistort brick
// (findUndistort); the tracker holds it by shared_ptr (survives a later
// detach). `name` = the graph node id / meter name (default `<src>/kcf`).
// Mirrors createTracker's object surface (arm/override/probe/stall/iterate).
static FN(createChainedTracker) {
  auto env = info.Env();
  try {
    const auto srcId = info[0].As<Napi::String>().Utf8Value();
    ChainedKcfTrackerStream::Source source;
    if (auto conv = Arv::findConverter(srcId))
      source = conv;
    else if (auto und = Arv::findUndistort(srcId))
      source = und;
    JS_ASSERT(source != nullptr, Error,
              "createChainedTracker: no convert/undistort brick attached to "
              "pipe " +
                  srcId,
              env.Undefined());
    std::string name = info.Length() >= 2 && info[1].IsString()
                           ? info[1].As<Napi::String>().Utf8Value()
                           : srcId + "/kcf";
    auto stream = ChainedKcfTrackerStream::create(std::move(source),
                                                  std::move(name));
    TrackerHandle::Ptr handle = std::move(stream);
    return KcfTrackerObject::Create(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// Factory: `createHybridTracker(camera, name?)` — the higher-fps hybrid NCC
// tracker on a camera's shared Arv::Stream. Byte-for-byte the same object
// surface / meter schema / async-iterated TrackResult as createTracker (it
// wraps the SAME KcfTrackerObject over the SAME TrackerHandle) — a pure
// drop-in; only the engine differs. `name` = the graph node id / meter name
// (default legacy-safe "tracker:center", so it replaces the same node).
static FN(createHybridTracker) {
  auto env = info.Env();
  try {
    auto camera = convert<Arv::Camera::Ptr>(info[0]);
    auto stream = info.Length() >= 2 && info[1].IsString()
                      ? HybridTrackerStream::create(
                            Arv::Stream::get(camera),
                            info[1].As<Napi::String>().Utf8Value())
                      : HybridTrackerStream::create(Arv::Stream::get(camera));
    TrackerHandle::Ptr handle = std::move(stream);
    return KcfTrackerObject::Create(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// Factory: `createChainedHybridTracker(sourcePipeId, name?)` — the hybrid NCC
// twin of createChainedTracker (tracks a convert/undistort brick's OwnedFrame
// tap). Same object surface; `name` defaults to `<src>/hybrid`.
static FN(createChainedHybridTracker) {
  auto env = info.Env();
  try {
    const auto srcId = info[0].As<Napi::String>().Utf8Value();
    ChainedHybridTrackerStream::Source source;
    if (auto conv = Arv::findConverter(srcId))
      source = conv;
    else if (auto und = Arv::findUndistort(srcId))
      source = und;
    JS_ASSERT(source != nullptr, Error,
              "createChainedHybridTracker: no convert/undistort brick attached "
              "to pipe " +
                  srcId,
              env.Undefined());
    std::string name = info.Length() >= 2 && info[1].IsString()
                           ? info[1].As<Napi::String>().Utf8Value()
                           : srcId + "/hybrid";
    auto stream = ChainedHybridTrackerStream::create(std::move(source),
                                                     std::move(name));
    TrackerHandle::Ptr handle = std::move(stream);
    return KcfTrackerObject::Create(env, handle);
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
          it->tracker = makeKcf(); // (re-)init on this frame
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
    // Channel-normalize once for all targets (see makeKcf/asColor8 for the
    // OpenCV 4.13 constraints on what cv::TrackerKCF accepts).
    const cv::Mat &colorFrame = asColor8(*mat, color_);

    auto result = MultiTrackResult::create();
    result->targets.reserve(slots_.size());
    const cv::Rect frameRect(0, 0, colorFrame.cols, colorFrame.rows);
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
          s.tracker->init(colorFrame, roi);
          s.needsInit = false;
          out.ok = true; // the init frame reports the armed roi itself
          out.bbox = roi;
        } else {
          cv::Rect bbox;
          out.ok = s.tracker->update(colorFrame, bbox);
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
  cv::Mat color_;            // reused 3-channel BGR view for KCF (transform thread)
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

// The native IMM motion-predictor brick (prediction-compose-node.md) lives in
// its own TU (ImmPredictor.cpp) but JOINS the Tracker namespace — the brick is
// logically a tracker post-stage (createImmPredictor + the ImmPredictor class).
void exportImmNamespace(Napi::Env env, Napi::Object &exports);

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportTrackerNamespace(Napi::Env env, Napi::Object &exports) {
  TrackerKCFObject::Export(env, exports);
  KcfTrackerObject::Export(env, exports); // register the class for Create()
  MultiKcfObject::Export(env, exports);   // register the class for Create()
  EXPORT(exports, createTracker);
  EXPORT(exports, createChainedTracker);
  EXPORT(exports, createHybridTracker);
  EXPORT(exports, createChainedHybridTracker);
  EXPORT(exports, createMultiTracker);
  exportImmNamespace(env, exports); // createImmPredictor + ImmPredictor class
}
#undef EXPORT
