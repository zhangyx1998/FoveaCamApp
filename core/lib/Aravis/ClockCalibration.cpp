// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera clock calibration (see ClockCalibration.h for the ruling + clock
// domain contract): the min-filter estimator, the blocking+exclusive latch
// run, the per-serial stability ring, and the NAPI read surface
// (`steadyNowNs` root export, `Aravis.clockStabilityAll`, the hardware-free
// `__clockCalSelfTest`).

#include <algorithm>
#include <deque>
#include <map>
#include <mutex>

#include <CallbackSlot.h>
#include <utils/thread.h>
#include <napi-helper.h>

#include "Camera.h"
#include "ClockCalibration.h"

using namespace Napi;

namespace Arv {

// GenICam feature spellings (SFNC; FLIR/Basler-compatible). The latched value
// is assumed NANOSECONDS on modern USB3V cameras — RIG-CHECK per model (a
// tick-based model needs TimestampTickFrequency scaling here).
static constexpr const char *LATCH_EXEC = "TimestampLatch";
static constexpr const char *LATCH_VALUE = "TimestampLatchValue";

static constexpr size_t RING_DEPTH = 8; // stability history per camera

// TWO-TIER LOCKING (ClockCalibration.h): the global mutex serializes ONLY
// INITIAL boot-pass bursts bus-wide; per-device serialization is the camera's
// own guard (always held). g_regMutex is the registry's short internal data
// lock — data-structure safety, never held across device I/O.
static std::mutex g_initMutex;
static std::mutex g_regMutex;
static std::map<std::string, std::deque<ClockCal>> g_rings;

// The clock-metrics PUSH channel (CallbackSlot.h — the generalized primitive;
// this is its first channel). Armed/disarmed via `Aravis.onClockMetrics`.
static CallbackSlot g_clockMetrics{"clockMetrics"};

// ---- estimator (exact port of time-align.ts estimateOffsetNs) --------------
ClockCal estimateLatchOffset(const std::vector<LatchSample> &samples,
                             int64_t atNs) {
  if (samples.empty())
    throw std::runtime_error("estimateLatchOffset: no samples");
  const auto mid = [](const LatchSample &s) { return s.t0 + (s.t1 - s.t0) / 2; };
  // Best = FIRST sample with the strictly-smallest RTT (JS `<` semantics).
  const LatchSample *best = &samples[0];
  for (const auto &s : samples)
    if ((s.t1 - s.t0) < (best->t1 - best->t0))
      best = &s;
  std::vector<int64_t> offsets;
  offsets.reserve(samples.size());
  for (const auto &s : samples)
    offsets.push_back(mid(s) - s.subjectNs);
  std::sort(offsets.begin(), offsets.end());
  const size_t n = offsets.size();
  const size_t p90 = std::min(n - 1, static_cast<size_t>(
                                         static_cast<double>(n) * 0.9));
  ClockCal cal;
  cal.offsetNs = mid(*best) - best->subjectNs;
  cal.jitterNs = offsets[p90] - offsets[0];
  cal.samples = static_cast<uint32_t>(n);
  cal.atNs = atNs;
  return cal;
}

// ---- stability rows + the push channel (forward decls used below) ----------
static ClockStability stabilityOf(const std::deque<ClockCal> &ring,
                                  int64_t nowNs);
// Fire the metrics row onto the JS main thread — SKIPPED ENTIRELY (one
// atomic load) while no callback is registered. Any thread.
static void fireClockMetrics(const std::string &serial,
                             const ClockStability &s) {
  if (!g_clockMetrics.armed())
    return;
  g_clockMetrics.fire([serial, s](Napi::Env env) -> Napi::Value {
    auto row = stabilityToJs(env, s);
    row.Set("serial", Napi::String::New(env, serial));
    return row;
  });
}

// ---- THE calibration routine (blocking; two-tier locking) -------------------
ClockCal calibrateCameraClock(const Camera &camera, int n, bool initial) {
  // Tier 1a: initial boot passes serialize BUS-WIDE (precision-sensitive
  // bursts must not overlap while devices come up). Drift/manual runs skip
  // this lock and may overlap across devices.
  std::unique_lock<std::mutex> init(g_initMutex, std::defer_lock);
  if (initial)
    init.lock();
  // Tier 1b: per-DEVICE guard, always held — the owner thread's drift pass
  // and a manual `calibrateClock` nudge on the same camera serialize here.
  std::scoped_lock device(camera.clock_cal_mutex());
  if (n < 1)
    n = 1;
  std::vector<LatchSample> samples;
  samples.reserve(static_cast<size_t>(n));
  for (int i = 0; i < n; ++i) {
    LatchSample s;
    s.t0 = steadyNowNs();
    camera.execute_feature(LATCH_EXEC); // throws Arv::Error when unsupported
    s.t1 = steadyNowNs();
    // Read AFTER the bracket (the latch pinned the counter inside it). The
    // per-iteration bound is the GenICam control-transfer timeout — a dead
    // device fails the roundtrip, it doesn't hang the guards.
    s.subjectNs = camera.get_feature_int(LATCH_VALUE);
    samples.push_back(s);
  }
  auto cal = estimateLatchOffset(samples, steadyNowNs());
  // OWNER-APPLIED dt: atomic swap — frames stamped after this instant carry
  // the new offset; in-flight frames keep the old one (accepted step).
  camera.set_clock_offset_ns(cal.offsetNs);
  const std::string serial = camera.get_serial();
  ClockStability stability;
  {
    // Tier 2: the registry's own short data lock (never spans device I/O).
    std::scoped_lock reg(g_regMutex);
    auto &ring = g_rings[serial];
    ring.push_back(cal);
    if (ring.size() > RING_DEPTH)
      ring.pop_front();
    stability = stabilityOf(ring, steadyNowNs());
  }
  fireClockMetrics(serial, stability); // push channel (no-op unobserved)
  return cal;
}

// ---- the owner thread (ClockCalibrator) --------------------------------------
ClockCalibrator::ClockCalibrator(const Camera &camera)
    : camera_(camera), thread_(&ClockCalibrator::run, this) {}

ClockCalibrator::~ClockCalibrator() {
  {
    std::scoped_lock lock(m_);
    stop_ = true;
  }
  cv_.notify_all();
  if (thread_.joinable())
    thread_.join(); // bounded by one in-flight burst (~n roundtrips)
}

void ClockCalibrator::run() {
  set_thread_name("ClockCalibrator");
  // INITIAL pass (global-mutex-serialized bus-wide). Latch-unsupported (or
  // init-transient) → mark uncalibrated (no row, dt stays 0) and EXIT — no
  // retry spin; the manual `calibrateClock` NAPI can retry on demand.
  try {
    calibrateCameraClock(camera_, 10, /*initial=*/true);
  } catch (const std::exception &e) {
    WARN("ClockCalibrator: initial calibration unavailable (%s) — "
         "uncalibrated (dt=0), drift loop disabled",
         e.what());
    return;
  }
  // INCREMENTAL drift loop: parked on the cv between runs; overlapping with
  // other devices' runs is allowed (per-device guard only).
  std::unique_lock<std::mutex> lock(m_);
  while (!stop_) {
    if (cv_.wait_for(lock, DRIFT_PERIOD, [this] { return stop_; }))
      return; // stop signalled
    lock.unlock();
    try {
      calibrateCameraClock(camera_, 10, /*initial=*/false);
    } catch (const std::exception &e) {
      // Transient (device busy/unplugged mid-run): skip this period.
      WARN("ClockCalibrator: drift re-calibration failed (%s) — skipped",
           e.what());
    }
    lock.lock();
  }
}

// ---- stability reads ---------------------------------------------------------
static ClockStability stabilityOf(const std::deque<ClockCal> &ring,
                                  int64_t nowNs) {
  ClockStability s;
  s.last = ring.back();
  s.ageNs = nowNs - s.last.atNs;
  if (ring.size() >= 2) {
    const ClockCal &prev = ring[ring.size() - 2];
    const int64_t dt = s.last.atNs - prev.atNs;
    if (dt > 0) {
      s.hasDrift = true;
      s.driftPpm = static_cast<double>(s.last.offsetNs - prev.offsetNs) /
                   static_cast<double>(dt) * 1e6;
    }
  }
  return s;
}

std::optional<ClockStability> clockStability(const std::string &serial) {
  std::scoped_lock reg(g_regMutex);
  auto it = g_rings.find(serial);
  if (it == g_rings.end() || it->second.empty())
    return std::nullopt;
  return stabilityOf(it->second, steadyNowNs());
}

std::vector<std::pair<std::string, ClockStability>> clockStabilityAll() {
  std::scoped_lock reg(g_regMutex);
  std::vector<std::pair<std::string, ClockStability>> out;
  const int64_t now = steadyNowNs();
  out.reserve(g_rings.size());
  for (const auto &[serial, ring] : g_rings)
    if (!ring.empty())
      out.emplace_back(serial, stabilityOf(ring, now));
  return out;
}

bool isClockCalibrated(const std::string &serial) {
  std::scoped_lock reg(g_regMutex);
  auto it = g_rings.find(serial);
  return it != g_rings.end() && !it->second.empty();
}

// ---- NAPI surface -------------------------------------------------------------
// Root `steadyNowNs()` — THE host clock, exported next to `cleanup` (JS
// hostNowNs delegates here so there is exactly one time authority).
FN(steadyNowNsJs) {
  return BigInt::New(info.Env(), Arv::steadyNowNs());
}

Napi::Object stabilityToJs(Napi::Env env, const ClockStability &s) {
  auto o = Napi::Object::New(env);
  o.Set("offsetNs", BigInt::New(env, s.last.offsetNs));
  o.Set("jitterNs", BigInt::New(env, s.last.jitterNs));
  o.Set("samples", Number::New(env, static_cast<double>(s.last.samples)));
  o.Set("atNs", BigInt::New(env, s.last.atNs));
  o.Set("ageNs", BigInt::New(env, s.ageNs));
  o.Set("driftPpm", s.hasDrift ? Napi::Value(Number::New(env, s.driftPpm))
                               : Napi::Value(env.Null()));
  return o;
}

// Bulk read for the 1 Hz clocks poll: `{ [serial]: stability row }`.
FN(clockStabilityAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  for (const auto &[serial, s] : Arv::clockStabilityAll())
    out.Set(serial, stabilityToJs(env, s));
  return out;
}

// `Aravis.onClockMetrics(cb | null)` — arm/disarm the clock-metrics PUSH
// channel. MAIN THREAD only (inherently: it's a NAPI setter). While armed,
// every successful calibration (owner-thread init/drift or manual) delivers
// { serial, offsetNs, jitterNs, samples, atNs, ageNs, driftPpm } to `cb` via
// the Dispatcher; while disarmed the owner threads skip the dispatch
// entirely (one atomic load). Env teardown disarms automatically.
FN(onClockMetrics) {
  auto env = info.Env();
  try {
    g_clockMetrics.set(env,
                       info.Length() > 0 ? info[0] : Napi::Value(env.Null()));
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// Test-only (core/test/24): prove the CallbackSlot gating + cross-thread
// delivery camera-less — fires a SYNTHETIC metrics row from a spawned native
// thread (the owner-thread topology, without hardware). Does NOT touch the
// registry. Returns the slot's armed state at fire time.
FN(__fireClockMetricsTest) {
  auto env = info.Env();
  try {
    const auto serial = info[0].As<Napi::String>().Utf8Value();
    ClockStability s;
    s.last = {/*offsetNs=*/123456789, /*jitterNs=*/4200, /*samples=*/10,
              /*atNs=*/steadyNowNs()};
    s.ageNs = 0;
    s.hasDrift = true;
    s.driftPpm = 1.5;
    const bool armed = g_clockMetrics.armed();
    std::thread producer([serial, s] { fireClockMetrics(serial, s); });
    producer.join();
    return Boolean::New(env, armed);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- min-filter self-test (hardware-free; driven by core/test/24) -----------
FN(__clockCalSelfTest) {
  auto env = info.Env();
  try {
    auto expect = [](bool cond, const char *what) {
      if (!cond)
        throw std::runtime_error(std::string("clock-cal self-test: ") + what);
    };
    // Empty set throws.
    {
      bool threw = false;
      try {
        estimateLatchOffset({}, 0);
      } catch (const std::exception &) {
        threw = true;
      }
      expect(threw, "empty sample set throws");
    }
    // Single sample: offset = midpoint − subject, jitter 0.
    {
      const auto c = estimateLatchOffset({{1000, 3000, 500}}, 42);
      expect(c.offsetNs == 2000 - 500, "single-sample offset = mid − subject");
      expect(c.jitterNs == 0, "single-sample jitter 0");
      expect(c.samples == 1 && c.atNs == 42, "single-sample bookkeeping");
    }
    // Min-RTT pick: the tightest bracket wins even when other candidate
    // offsets are smaller (latency noise is one-sided — trust the bracket).
    {
      std::vector<LatchSample> s = {
          {0, 1000, 0},    // rtt 1000, candidate offset 500
          {0, 100, -400},  // rtt  100, candidate offset 450  <- tightest
          {0, 100, -350},  // rtt  100 again: FIRST minimal must win
          {0, 2000, 800},  // rtt 2000, candidate offset 200 (late latch)
      };
      const auto c = estimateLatchOffset(s, 0);
      expect(c.offsetNs == 450, "min-RTT (first minimal) sample wins");
      // candidates sorted: 200, 400, 450, 500; p90 idx = min(3, floor(3.6)) = 3
      expect(c.jitterNs == 500 - 200, "jitter = p90 − min");
    }
    // p90 index semantics at n = 10: floor(10 × 0.9) = 9 → the max.
    {
      std::vector<LatchSample> s;
      for (int i = 0; i < 10; ++i) // candidate offsets 100, 110, ... 190
        s.push_back({0, 10 + i, -(100 + 10 * i) + (10 + i) / 2});
      const auto c = estimateLatchOffset(s, 0);
      expect(c.jitterNs == 190 - 100, "n=10 p90 hits the last candidate");
      expect(c.offsetNs == 100, "tightest bracket (i=0) offset");
    }
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Arv
