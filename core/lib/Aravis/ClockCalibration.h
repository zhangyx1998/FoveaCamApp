// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// unified-time (user ruling, 2026-07-08, structural revision): THE HARDWARE
// OWNER THREAD OWNS CALIBRATION. Every `Arv::Camera` spawns a lightweight
// `ClockCalibrator` thread at device initialization which (a) runs the
// initial latch calibration, then (b) re-runs an incremental drift
// calibration every `DRIFT_PERIOD` (30 s), parking in between. A camera
// whose model lacks the latch features fails the initial attempt ONCE, stays
// uncalibrated (dt = 0) and the thread exits — no retry spin; the manual
// `camera.calibrateClock(n?)` NAPI (a thin trigger onto the SAME guarded
// routine) can retry on demand.
//
// TWO-TIER LOCKING (user refinement, 2026-07-08):
//   1. The GLOBAL calibration mutex guards ONLY INITIAL runs — device owners'
//      boot-time latch bursts serialize against each other (three cameras
//      coming up must not run precision-sensitive bursts concurrently on the
//      bus). INCREMENTAL drift runs do NOT take it and may overlap — with
//      each other and with another device's initial run. Per-device
//      serialization is a PER-DEVICE guard (Camera::clock_cal_mutex): the
//      owner thread only calibrates its own device, and the manual
//      `calibrateClock` nudge takes the same device guard, never the global.
//   2. The stability-ring/registry map keeps its own short internal data
//      lock — data-structure safety, distinct from the calibration mutexes.
// Metrics surface two ways: PULL (`camera.clockCalibration`,
// `Aravis.clockStabilityAll` for the 1 Hz poll) and an optional PUSH channel
// (`Aravis.onClockMetrics(cb|null)` through the shared `CallbackSlot`
// primitive — zero cross-thread cost while no callback is registered).
//
// CLOCK DOMAIN CONTRACT: `steadyNowNs()` below is THE host time authority —
// every offset this module computes/stores is "device counter → steadyNowNs
// domain". JS `hostNowNs` delegates to it (hrtime and libc++ steady_clock are
// not guaranteed the same Darwin clock domain, so there is exactly ONE
// authority: this one).
//
// OWNER-APPLIED dt: on success the offset is stored into the camera's atomic
// `clock_offset_ns` (Camera.h) and Frame creation — the single choke point
// where device timestamps enter the system — stamps every outward timestamp
// pre-calibrated (JS Frame.deviceTimestamp, SHM SlotHeader deviceTimestamp,
// OwnedFrame tap, KCF results). Mid-task recalibration is an atomic swap: in-
// flight frames keep the offset they were stamped with; a small step at the
// swap instant is inherent and accepted, never torn.
//
// STABILITY: the registry keeps the last K=8 results per camera; the reader
// derives ageNs (steadyNowNs − atNs at READ time) and driftPpm between the
// two most recent runs — refreshed immediately by every successful call, so
// the 1 Hz clocks poll needs no extra plumbing.

#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <napi.h>

namespace Arv {

class Camera;

/** THE native host time authority: libc++ std::chrono::steady_clock, integer
 *  nanoseconds. All calibration offsets are expressed in THIS domain. */
inline int64_t steadyNowNs() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

/** One calibration result (mirror of the JS `ClockCalibration`, method
 *  "latch"). `hostNs = rawDeviceNs + offsetNs`, both in steadyNowNs domain. */
struct ClockCal {
  int64_t offsetNs = 0;
  int64_t jitterNs = 0; // p90 − min over the candidate offsets (confidence)
  uint32_t samples = 0;
  int64_t atNs = 0; // steadyNowNs when this calibration completed
};

/** Read-side stability row (per-serial): the most recent calibration + its
 *  age and the offset drift rate vs the previous run. */
struct ClockStability {
  ClockCal last;
  int64_t ageNs = 0;     // steadyNowNs (at read) − last.atNs
  bool hasDrift = false; // ≥2 calibrations in the ring
  double driftPpm = 0;   // (Δoffset / Δat) × 1e6 between the two newest runs
};

/** One latch round-trip observation: host bracket [t0, t1] (steadyNowNs)
 *  around the latch EXECUTE, `subjectNs` = the latched device counter read
 *  back after the bracket. */
struct LatchSample {
  int64_t t0 = 0;
  int64_t t1 = 0;
  int64_t subjectNs = 0;
};

/** The RULED min-filter estimator (exact port of time-align.ts
 *  `estimateOffsetNs`): pick the sample with the smallest bracket (min RTT,
 *  FIRST minimal wins — the least latency-contaminated observation); offset =
 *  its midpoint − subject. Jitter = p90 − min over ALL candidate offsets
 *  (p90 index = min(n−1, floor(n×0.9)) on the sorted candidates). Throws on
 *  an empty sample set. Pure — unit-tested via `__clockCalSelfTest`. */
ClockCal estimateLatchOffset(const std::vector<LatchSample> &samples,
                             int64_t atNs);

/** THE calibration routine (blocking): N × { t0 = steadyNowNs; execute
 *  TimestampLatch; t1; read TimestampLatchValue } → min-filter → store the
 *  offset on the camera (atomic swap, owner-applied from the next frame) +
 *  append to the stability ring + fire the push channel when armed. Locking
 *  is TWO-TIER (header note): always the camera's own per-device guard;
 *  `initial = true` (the owner thread's boot pass) ADDITIONALLY holds the
 *  global mutex so initial bursts never overlap bus-wide. Drift passes and
 *  the manual `calibrateClock` trigger run per-device-guarded only. Throws
 *  Arv::Error when the camera lacks the latch features (first roundtrip);
 *  nothing is stored on failure. */
ClockCal calibrateCameraClock(const Camera &camera, int n = 10,
                              bool initial = false);

/** Drift re-calibration period of the owner thread (a burst is ~n control
 *  roundtrips ≈ tens of ms — far too long for the capture thread at frame
 *  rate, hence the dedicated thread; at one burst / 30 s the control-channel
 *  overhead is negligible while 10–50 ppm oscillator drift stays ≪ 1 ms). */
constexpr auto DRIFT_PERIOD = std::chrono::seconds(30);

/** The camera-owned calibration thread (unified-time structural revision):
 *  spawned by the Camera at device initialization, parked between runs on a
 *  condition variable, joined by the Camera's destructor. Initial attempt
 *  once (global-mutex-serialized); on latch-unsupported it marks the camera
 *  uncalibrated and EXITS (the drift loop only ever runs on a camera whose
 *  initial pass succeeded); transient drift-run failures are logged and
 *  skipped, never fatal. */
class ClockCalibrator {
public:
  explicit ClockCalibrator(const Camera &camera);
  ~ClockCalibrator(); // signal stop + join (bounded by one in-flight burst)
  ClockCalibrator(const ClockCalibrator &) = delete;
  ClockCalibrator &operator=(const ClockCalibrator &) = delete;

private:
  void run();
  const Camera &camera_; // the OWNER: constructs us last, destroys us first
  std::mutex m_;
  std::condition_variable cv_;
  bool stop_ = false;
  std::thread thread_;
};

/** The enriched stability row for one camera (ageNs computed at read time),
 *  or nullopt when no calibration has succeeded yet. */
std::optional<ClockStability> clockStability(const std::string &serial);

/** Bulk read for the 1 Hz clocks poll — every calibrated camera's row. */
std::vector<std::pair<std::string, ClockStability>> clockStabilityAll();

/** True once `calibrateCameraClock` has succeeded for this serial — the
 *  homography bricks' `calibratedClock` probe reads this. */
bool isClockCalibrated(const std::string &serial);

/** ClockStability → the JS row {offsetNs, jitterNs, samples, atNs, ageNs,
 *  driftPpm|null} (bigints in the steadyNowNs domain). Shared by the
 *  `camera.clockCalibration` getter and `Aravis.clockStabilityAll`. */
Napi::Object stabilityToJs(Napi::Env env, const ClockStability &s);

} // namespace Arv
