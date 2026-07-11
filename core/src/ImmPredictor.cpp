// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// NATIVE IMM (Interacting Multiple Model) Kalman motion-predictor BRICK
// (docs/proposals/prediction-compose-node.md — supersedes the inline
// `app/orchestrator/imm-node.ts` wiring of imm-delay-compensation.md; the
// filter math, sign convention, and per-triple `delay_compensation_ms` offset
// all carry forward). Unlike the retired TS node (a synchronous per-tracker-
// result transform), this is a STANDALONE PRODUCER on its OWN free-running
// thread: it ingests tracker measurements at ~60 Hz and emits PREDICTIONS at a
// configurable rate (default 600 Hz), so the imm node finally shows on the
// profiler graph with a truthful high output rate.
//
// The pure filter is a byte-faithful C++ port of `app/lib/imm-predictor.ts`
// (KEPT as the REFERENCE implementation): three models (CP/CV/CA) over a shared
// per-axis [pos,vel,acc] state, two decoupled scalar-position IMMs, a JOINT
// innovation gate, and identical reset/passthrough/NaN-hygiene semantics. The
// TS reference and this brick are pinned to the SAME conformance vectors
// (docs/schema/codec/imm-vectors.json), validated by BOTH vitest (against the
// TS filter) and core/test/42-imm-predictor.ts (against this brick's `ingest`).
//
// TIME: the measurement-update `dt` uses the TRUSTED device timestamp (never
// wall clock — the ruled invariant). The BETWEEN-frame coasting uses a local
// steady-clock delta since the last measurement (the only clock available off
// a frame boundary); its magnitude is at most one frame interval plus the
// signed delay, so the domain mix is negligible. Propagation distance is
// Δ = coastSec + delaySec: at a measurement (coast≈0) it equals the reference's
// `delayMs` lead; between frames it grows so the 600 Hz stream extrapolates the
// target's motion smoothly instead of stair-stepping at camera rate.
//
// Brick shape follows the tracker-brick pattern (Tracker.cpp): a
// `Stream<ImmResult::Ptr>` producer whose thread wakes on the fixed period,
// async-iterator output (Sub::Queue), a `Meter::ThreadMeter` (single writer =
// the predict thread) probed out-of-loop. Like the chained tracker it does NOT
// self-report Topology — the disparity-scope session registers its graph node +
// `tracker → imm` edge and folds this meter via `registerNativeProbe`.

#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <string>

#include <napi.h>
#include <opencv2/core.hpp> // cv::Point2d / cv::Rect (measurement shapes)

#include "CoreObject.h"
#include "Iterator.h"    // TransformStream seam: Sub::Queue / Sub::Iterator
#include "PortPipe.h"    // measure_in port (native-port-pipe.md)
#include "Stream/Stream.h"
#include "ThreadMeter.h"
#include "TrackResult.h" // the measure_in payload (tracker link)
#include "napi-helper.h"
#include "utils/thread.h" // set_thread_name (glibc: ≤15 chars)

using namespace Napi;

// Shared full-schema meter serializer (defined in ConverterStream.cpp) — the
// same one Tracker.cpp forward-declares, so the imm probe folds through the
// identical `TrackerMeter` shape (`trackerWorkload` in the session).
namespace Arv {
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);
}

// Free helpers carry internal linkage (static) so they never clash with the
// like-named helpers in Tracker.cpp across TUs — the same discipline that file
// uses (`static FN`, `static nowMs`). Type names below are unique to this TU.

static int64_t nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}
static int64_t nowNs() {
  using namespace std::chrono;
  return duration_cast<nanoseconds>(steady_clock::now().time_since_epoch())
      .count();
}

constexpr double NS_PER_SEC = 1e9;

// Clamp the global prediction rate to the ruled window (proposal ruling 2). The
// TS/UI layer clamps too; this is the defensive floor/ceiling on the brick.
constexpr double kRateMin = 60.0;
constexpr double kRateMax = 1000.0;
static double clampRate(double hz) {
  if (!std::isfinite(hz)) return 600.0;
  return std::min(kRateMax, std::max(kRateMin, hz));
}

// ===========================================================================
// Pure IMM filter — a faithful port of app/lib/imm-predictor.ts. All arithmetic
// mirrors the reference operation-by-operation so the shared conformance
// vectors reproduce on both sides.
// ===========================================================================

using Vec3 = std::array<double, 3>;
using Mat3 = std::array<std::array<double, 3>, 3>;

constexpr double FLOOR = 1e-3; // diagonal floor for collapsed dimensions

struct Tuning {
  double measurementVar = 4;   // R (px²)
  double cvAccelPsd = 400;     // white-noise-acceleration PSD (CV)
  double caJerkPsd = 5000;     // white-noise-jerk PSD (CA)
  double cpPosPsd = 1;         // random-walk position PSD (CP)
  double gate = 30;            // joint innovation gate (χ², 2 dof)
  double maxGapMs = 500;       // dt above this ms → reinit at the measurement
};

// Model order: 0 = CP, 1 = CV, 2 = CA (matches FULL_TRANSITION / INITIAL_PROB).
static void modelF(int k, double dt, Mat3 &F) {
  F = {{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}};
  switch (k) {
  case 0: // CP — constant position
    F[0][0] = 1;
    break;
  case 1: // CV — constant velocity
    F[0][0] = 1; F[0][1] = dt;
    F[1][1] = 1;
    break;
  default: // CA — constant acceleration
    F[0][0] = 1; F[0][1] = dt; F[0][2] = 0.5 * dt * dt;
    F[1][1] = 1; F[1][2] = dt;
    F[2][2] = 1;
    break;
  }
}

static void modelQ(int k, double dt, const Tuning &t, Mat3 &Q) {
  Q = {{{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}};
  const double d2 = dt * dt, d3 = d2 * dt, d4 = d3 * dt, d5 = d4 * dt;
  switch (k) {
  case 0: // CP — random-walk position; vel/acc floored
    Q[0][0] = t.cpPosPsd * dt;
    Q[1][1] = FLOOR;
    Q[2][2] = FLOOR;
    break;
  case 1: { // CV — white-noise-acceleration over [p,v]; acc floored
    const double q = t.cvAccelPsd;
    Q[0][0] = (q * d3) / 3; Q[0][1] = (q * d2) / 2;
    Q[1][0] = (q * d2) / 2; Q[1][1] = q * dt;
    Q[2][2] = FLOOR;
    break;
  }
  default: { // CA — white-noise-jerk over [p,v,a]
    const double q = t.caJerkPsd;
    Q[0][0] = (q * d5) / 20; Q[0][1] = (q * d4) / 8;  Q[0][2] = (q * d3) / 6;
    Q[1][0] = (q * d4) / 8;  Q[1][1] = (q * d3) / 3;  Q[1][2] = (q * d2) / 2;
    Q[2][0] = (q * d3) / 6;  Q[2][1] = (q * d2) / 2;  Q[2][2] = q * dt;
    break;
  }
  }
}

static Vec3 matVec(const Mat3 &A, const Vec3 &x) {
  Vec3 out{0, 0, 0};
  for (int i = 0; i < 3; i++) {
    double s = 0;
    for (int j = 0; j < 3; j++) s += A[i][j] * x[j];
    out[i] = s;
  }
  return out;
}

static Mat3 matMat(const Mat3 &A, const Mat3 &B) {
  Mat3 out{};
  for (int i = 0; i < 3; i++)
    for (int k = 0; k < 3; k++) {
      const double aik = A[i][k];
      if (aik == 0) continue;
      for (int j = 0; j < 3; j++) out[i][j] += aik * B[k][j];
    }
  return out;
}

static Mat3 transpose(const Mat3 &A) {
  Mat3 out{};
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) out[i][j] = A[j][i];
  return out;
}

static void symmetrize(Mat3 &A) {
  for (int i = 0; i < 3; i++)
    for (int j = i + 1; j < 3; j++) {
      const double m = 0.5 * (A[i][j] + A[j][i]);
      A[i][j] = A[j][i] = m;
    }
}

static bool isFiniteVec(const Vec3 &x) {
  for (double v : x) if (!std::isfinite(v)) return false;
  return true;
}
static bool isFiniteMat(const Mat3 &A) {
  for (const auto &row : A) if (!isFiniteVec(row)) return false;
  return true;
}

static Mat3 initCovariance(double measurementVar) {
  return {{{measurementVar, 0, 0}, {0, 1e4, 0}, {0, 0, 1e6}}};
}

// Full 3-model transition (rows i→cols j, self-biased) + initial probabilities
// (already normalized — the brick always runs all three models).
constexpr Mat3 kTransition = {{{0.94, 0.05, 0.01},
                               {0.05, 0.90, 0.05},
                               {0.01, 0.09, 0.90}}};
constexpr Vec3 kInitialProb = {0.2, 0.6, 0.2};

// --- per-axis IMM (3 models) -----------------------------------------------
class AxisImm {
public:
  explicit AxisImm(const Tuning &t) : t_(t), R_(t.measurementVar) {
    reset(0);
  }

  void reset(double p) {
    for (int j = 0; j < 3; j++) {
      xs_[j] = {p, 0, 0};
      Ps_[j] = initCovariance(R_);
    }
    mu_ = kInitialProb;
    cbar_ = kInitialProb;
  }

  Vec3 combinedState() const {
    Vec3 x{0, 0, 0};
    for (int j = 0; j < 3; j++)
      for (int k = 0; k < 3; k++) x[k] += mu_[j] * xs_[j][k];
    return x;
  }

  double combinedPosVar() const {
    const double p = combinedState()[0];
    double v = 0;
    for (int j = 0; j < 3; j++) {
      const double d = xs_[j][0] - p;
      v += mu_[j] * (Ps_[j][0][0] + d * d);
    }
    return v;
  }

  // Advance by dt seconds; z = the measured position, or NaN for a miss
  // (predict-only). Returns the pre-update combined measurement + its variance
  // for the caller's JOINT gate.
  void step(double dt, double z, double &predZ, double &predS) {
    predict(dt);
    predictedMeasurement(predZ, predS);
    if (std::isnan(z)) noUpdate();
    else update(z);
  }

  bool degenerate() const {
    for (int j = 0; j < 3; j++)
      if (!isFiniteVec(xs_[j]) || !isFiniteMat(Ps_[j])) return true;
    return false;
  }

private:
  void predict(double dt) {
    // interaction / mixing
    Vec3 cbar{0, 0, 0};
    for (int j = 0; j < 3; j++)
      for (int i = 0; i < 3; i++) cbar[j] += kTransition[i][j] * mu_[i];
    cbar_ = cbar;

    std::array<Vec3, 3> mixedX{};
    std::array<Mat3, 3> mixedP{};
    for (int j = 0; j < 3; j++) {
      Vec3 x0{0, 0, 0};
      for (int i = 0; i < 3; i++) {
        const double w = cbar[j] > 0 ? (kTransition[i][j] * mu_[i]) / cbar[j] : 0;
        for (int k = 0; k < 3; k++) x0[k] += w * xs_[i][k];
      }
      Mat3 P0{};
      for (int i = 0; i < 3; i++) {
        const double w = cbar[j] > 0 ? (kTransition[i][j] * mu_[i]) / cbar[j] : 0;
        const Vec3 d = {xs_[i][0] - x0[0], xs_[i][1] - x0[1], xs_[i][2] - x0[2]};
        for (int a = 0; a < 3; a++)
          for (int b = 0; b < 3; b++)
            P0[a][b] += w * (Ps_[i][a][b] + d[a] * d[b]);
      }
      mixedX[j] = x0;
      mixedP[j] = P0;
    }

    // per-model predict
    for (int j = 0; j < 3; j++) {
      Mat3 F, Q;
      modelF(j, dt, F);
      modelQ(j, dt, t_, Q);
      const Vec3 x = matVec(F, mixedX[j]);
      const Mat3 FP = matMat(F, mixedP[j]);
      Mat3 P = matMat(FP, transpose(F));
      for (int a = 0; a < 3; a++)
        for (int b = 0; b < 3; b++) P[a][b] += Q[a][b];
      symmetrize(P);
      xs_[j] = x;
      Ps_[j] = P;
    }
  }

  void predictedMeasurement(double &z, double &S) const {
    z = 0;
    for (int j = 0; j < 3; j++) z += cbar_[j] * xs_[j][0];
    double s = 0;
    for (int j = 0; j < 3; j++) {
      const double d = xs_[j][0] - z;
      s += cbar_[j] * (Ps_[j][0][0] + d * d);
    }
    S = s + R_;
  }

  void update(double z) {
    Vec3 like{0, 0, 0};
    for (int j = 0; j < 3; j++) {
      Vec3 &x = xs_[j];
      Mat3 &P = Ps_[j];
      const double y = z - x[0];
      const double S = P[0][0] + R_;
      const Vec3 K = {P[0][0] / S, P[1][0] / S, P[2][0] / S};
      x[0] += K[0] * y;
      x[1] += K[1] * y;
      x[2] += K[2] * y;
      Mat3 newP{};
      for (int a = 0; a < 3; a++)
        for (int b = 0; b < 3; b++) newP[a][b] = P[a][b] - K[a] * P[0][b];
      symmetrize(newP);
      Ps_[j] = newP;
      like[j] = std::exp(-0.5 * (y * y) / S) / std::sqrt(2 * M_PI * S);
    }
    double sum = 0;
    Vec3 mu{0, 0, 0};
    for (int j = 0; j < 3; j++) {
      mu[j] = cbar_[j] * like[j];
      sum += mu[j];
    }
    if (sum > 0)
      for (int j = 0; j < 3; j++) mu[j] /= sum;
    else
      mu = cbar_;
    mu_ = mu;
  }

  void noUpdate() {
    double sum = 0;
    for (double c : cbar_) sum += c;
    if (sum > 0)
      for (int j = 0; j < 3; j++) mu_[j] = cbar_[j] / sum;
  }

  Tuning t_;
  double R_;
  std::array<Vec3, 3> xs_{};
  std::array<Mat3, 3> Ps_{};
  Vec3 mu_ = kInitialProb;
  Vec3 cbar_ = kInitialProb;
};

static double propagatePos(const Vec3 &s, double dt) {
  return s[0] + s[1] * dt + 0.5 * s[2] * dt * dt;
}

// ===========================================================================
// ImmCore — the filter pair + the reference `process()` semantics, split into a
// measurement `ingest` (mutates the filter, returns the ZERO-COAST prediction,
// i.e. the reference-equivalent) and a `predictAt(coastSec)` (pure re-read of
// the estimate, propagated by coast + delay for the free-running emit). Guarded
// by the owning stream's mutex; `ingest` runs on the NAPI thread, `predictAt`
// on the predict thread.
// ===========================================================================

// One measurement pushed from JS (mirror of TrackResult, device-clock stamped).
struct ImmMeasurement {
  bool found = false;
  bool overridden = false;
  double cx = 0, cy = 0; // center (valid iff found)
  bool hasBbox = false;
  double bx = 0, by = 0, bw = 0, bh = 0;
  uint64_t seq = 0;
  uint64_t deviceTimestamp = 0;
};

// One prediction emitted by the brick (or returned by ingest at zero coast).
struct ImmResult : Shared<ImmResult> {
  bool found = false;
  bool overridden = false;
  bool coasting = false; // emitted between measurements / on a predict-only miss
  bool hasCenter = false;
  double cx = 0, cy = 0;
  bool hasBbox = false;
  double bx = 0, by = 0, bw = 0, bh = 0;
  uint64_t seq = 0;
  uint64_t deviceTimestamp = 0;
  int64_t propagatedToNs = 0; // deviceTimestamp + Δ·1e9 (informational)
};

class ImmCore {
public:
  explicit ImmCore(const Tuning &t, double delaySec)
      : t_(t), delaySec_(delaySec), ax_(t), ay_(t) {
    reset();
  }

  void setDelaySec(double d) { delaySec_ = d; }

  void reset() {
    ax_.reset(0);
    ay_.reset(0);
    lastTs_ = -1;
    warm_ = false;
    lastWasMiss_ = false;
  }

  // Combined position variance per axis — test hook for coasting/gap assertions.
  void debugPosVar(double &vx, double &vy) const {
    vx = ax_.combinedPosVar();
    vy = ay_.combinedPosVar();
  }

  // Run one measurement through the filter (mirrors ImmPredictor.process). Sets
  // the coasting anchor and returns the reference-equivalent (zero-coast)
  // prediction so the conformance test can compare directly to the TS filter.
  ImmResult::Ptr ingest(const ImmMeasurement &m) {
    lastMeasWallNs_ = nowNs();

    // OVERRIDDEN (drag) → passthrough + RESET (a drag teleports the target).
    if (m.overridden) {
      reset();
      // remember the measurement so a coasting read after a drag has a shape,
      // though warm_ is false → predictAt yields nothing until a real result.
      storeMeas(m);
      return passthrough(m, /*coasting=*/false);
    }

    const int64_t ts = static_cast<int64_t>(m.deviceTimestamp);

    // MISS: predict-only advance to grow uncertainty; passthrough (found=false).
    if (!m.found) {
      if (lastTs_ != -1 && warm_) {
        const double dt = static_cast<double>(ts - lastTs_) / NS_PER_SEC;
        if (dt > 0 && dt <= t_.maxGapMs / 1000.0) {
          double pz, ps;
          ax_.step(dt, std::nan(""), pz, ps);
          ay_.step(dt, std::nan(""), pz, ps);
          lastTs_ = ts;
          if (ax_.degenerate() || ay_.degenerate()) reset();
        } else if (dt > t_.maxGapMs / 1000.0) {
          reset();
        }
      }
      lastWasMiss_ = true;
      storeMeas(m);
      return passthrough(m, /*coasting=*/false);
    }

    const double zx = m.cx, zy = m.cy;
    storeMeas(m);

    // First result (cold) / after a reset → (re)init at the measurement.
    if (lastTs_ == -1) {
      ax_.reset(zx);
      ay_.reset(zy);
      lastTs_ = ts;
      warm_ = true;
      lastWasMiss_ = false;
      return passthrough(m, /*coasting=*/false);
    }

    const double dt = static_cast<double>(ts - lastTs_) / NS_PER_SEC;
    if (dt <= 0) return passthrough(m, /*coasting=*/false); // duplicate/out-of-order
    if (dt > t_.maxGapMs / 1000.0) {
      ax_.reset(zx);
      ay_.reset(zy);
      lastTs_ = ts;
      warm_ = true;
      lastWasMiss_ = false;
      return passthrough(m, /*coasting=*/false);
    }

    // Step both axes + JOINT innovation gate on the pre-update prediction.
    double gxZ, gxS, gyZ, gyS;
    ax_.step(dt, zx, gxZ, gxS);
    ay_.step(dt, zy, gyZ, gyS);
    const double dx = zx - gxZ, dy = zy - gyZ;
    const double d2 = (gxS > 0 ? (dx * dx) / gxS : 0) +
                      (gyS > 0 ? (dy * dy) / gyS : 0);
    if (d2 > t_.gate) { // teleport / re-arm discontinuity → reinit
      ax_.reset(zx);
      ay_.reset(zy);
      lastTs_ = ts;
      warm_ = true;
      lastWasMiss_ = false;
      return passthrough(m, /*coasting=*/false);
    }

    lastTs_ = ts;
    if (ax_.degenerate() || ay_.degenerate()) {
      reset();
      return passthrough(m, /*coasting=*/false);
    }

    lastWasMiss_ = false;
    // Zero-coast prediction = propagate by the delay only (reference-equivalent).
    return propagate(0.0);
  }

  // Free-running emit: propagate the current estimate by (coast + delay). Null
  // when the filter is cold (no measurement yet) or the last measurement was a
  // miss with no center to coast.
  ImmResult::Ptr predictAt(int64_t wallNs) {
    if (!warm_) return nullptr;
    const double coastSec =
        static_cast<double>(wallNs - lastMeasWallNs_) / NS_PER_SEC;
    if (lastWasMiss_) {
      // Coast a miss: still no center (the JS lost-gate owns policy) but keep
      // the stream alive so the graph edge reads a truthful rate.
      auto r = ImmResult::create();
      r->found = false;
      r->coasting = true;
      r->seq = lastMeas_.seq;
      r->deviceTimestamp = lastMeas_.deviceTimestamp;
      r->propagatedToNs = static_cast<int64_t>(lastMeas_.deviceTimestamp);
      return r;
    }
    return propagate(coastSec > 0 ? coastSec : 0.0);
  }

private:
  void storeMeas(const ImmMeasurement &m) { lastMeas_ = m; }

  // Build a passthrough result carrying the measurement's own center/bbox
  // (mirrors the reference's "return r unchanged" branches).
  ImmResult::Ptr passthrough(const ImmMeasurement &m, bool coasting) {
    auto r = ImmResult::create();
    r->found = m.found;
    r->overridden = m.overridden;
    r->coasting = coasting;
    r->hasCenter = m.found;
    r->cx = m.cx;
    r->cy = m.cy;
    r->hasBbox = m.hasBbox;
    r->bx = m.bx; r->by = m.by; r->bw = m.bw; r->bh = m.bh;
    r->seq = m.seq;
    r->deviceTimestamp = m.deviceTimestamp;
    r->propagatedToNs = static_cast<int64_t>(m.deviceTimestamp);
    return r;
  }

  // Propagate the combined estimate by Δ = extraSec + delaySec and shift the
  // last measurement's bbox by the same delta (size preserved).
  ImmResult::Ptr propagate(double extraSec) {
    const double delta = extraSec + delaySec_;
    const Vec3 sx = ax_.combinedState();
    const Vec3 sy = ay_.combinedState();
    const double px = propagatePos(sx, delta);
    const double py = propagatePos(sy, delta);
    if (!std::isfinite(px) || !std::isfinite(py)) {
      reset();
      return passthrough(lastMeas_, /*coasting=*/false);
    }
    auto r = ImmResult::create();
    r->found = true;
    r->overridden = false;
    r->coasting = extraSec > 0;
    r->hasCenter = true;
    r->cx = px;
    r->cy = py;
    if (lastMeas_.hasBbox) {
      const double shiftX = px - lastMeas_.cx, shiftY = py - lastMeas_.cy;
      r->hasBbox = true;
      r->bx = lastMeas_.bx + shiftX;
      r->by = lastMeas_.by + shiftY;
      r->bw = lastMeas_.bw;
      r->bh = lastMeas_.bh;
    }
    r->seq = lastMeas_.seq;
    r->deviceTimestamp = lastMeas_.deviceTimestamp;
    r->propagatedToNs =
        static_cast<int64_t>(lastMeas_.deviceTimestamp) +
        static_cast<int64_t>(delta * NS_PER_SEC);
    return r;
  }

  Tuning t_;
  double delaySec_;
  AxisImm ax_, ay_;
  int64_t lastTs_ = -1;      // last measurement device timestamp (-1 = none)
  int64_t lastMeasWallNs_ = 0;
  bool warm_ = false;
  bool lastWasMiss_ = false;
  ImmMeasurement lastMeas_;
};

// ===========================================================================
// ImmStream — the free-running producer. Its base thread wakes every `period`,
// propagates the estimate, and emits one ImmResult (Sub::Queue → JS async
// iterator). `ingest` is called from the NAPI thread; both sides hold `mutex_`.
// ===========================================================================
class ImmStream : public Stream<ImmResult::Ptr> {
public:
  using Ptr = std::shared_ptr<ImmStream>;
  static Ptr create(const Tuning &t, double delaySec, double rateHz,
                    std::string name) {
    return std::make_shared<ImmStream>(t, delaySec, rateHz, std::move(name));
  }
  ImmStream(const Tuning &t, double delaySec, double rateHz, std::string name)
      : core_(t, delaySec), name_(name),
        meter_(std::move(name), {"measure"}, {"predict"}, nowMs()) {
    setPeriodNs(rateHz);
  }
  ~ImmStream() { shutdown(); }

  /** The graph node id (= meter name) — the `to` of a measure_in link edge. */
  const std::string &name() const { return name_; }

  // Push one measurement, return the zero-coast prediction. Meters one input
  // arrival and remembers the result (`lastIngest` — the piped-conformance
  // observation point). Called from the NAPI thread (ingest) OR a port link's
  // delivery thread (measure_in) — both serialize on `mutex_`.
  ImmResult::Ptr ingest(const ImmMeasurement &m) {
    std::scoped_lock lock(mutex_);
    meter_.ingest("measure", nowMs());
    auto out = core_.ingest(m);
    lastIngest_ = out;
    return out;
  }

  // measure_in sink (native-port-pipe.md): adapt a TrackResult off the link's
  // delivery thread into the measurement update. Same path as `ingest`.
  void ingestFromPort(const TrackResult &r) {
    ImmMeasurement m;
    m.found = r.found;
    m.overridden = r.overridden;
    m.cx = r.center.x;
    m.cy = r.center.y;
    if (r.bbox.width > 0 && r.bbox.height > 0) {
      m.hasBbox = true;
      m.bx = r.bbox.x;
      m.by = r.bbox.y;
      m.bw = r.bbox.width;
      m.bh = r.bbox.height;
    }
    m.seq = r.seq;
    m.deviceTimestamp = r.deviceTimestamp;
    ingest(m);
  }

  /** The most recent zero-coast ingest result (piped-conformance observation +
   *  debugging). Null before the first measurement. */
  ImmResult::Ptr lastIngest() {
    std::scoped_lock lock(mutex_);
    return lastIngest_;
  }

  // Live rate / delay change (Settings or drawer slider).
  void setParams(bool hasRate, double rateHz, bool hasDelay, double delayMs) {
    std::scoped_lock lock(mutex_);
    if (hasRate) setPeriodNs(rateHz);
    if (hasDelay) core_.setDelaySec(delayMs / 1000.0);
  }

  Meter::Snapshot probe() const { return meter_.probe(nowMs()); }

protected:
  // Stream producer hooks (predict thread).
  void start() override {
    set_thread_name("imm-predict"); // ≤15 chars (glibc)
  }
  void stop() override {}

  ImmResult::Ptr iterate() override {
    // Sleep out the period first (also paces the cold poll — no busy spin).
    const int64_t periodNs = periodNs_.load(std::memory_order_acquire);
    std::this_thread::sleep_for(std::chrono::nanoseconds(periodNs));
    ImmResult::Ptr r;
    {
      std::scoped_lock lock(mutex_);
      const int64_t t = nowMs();
      meter_.begin(t);
      r = core_.predictAt(nowNs());
      meter_.end(nowMs());
      if (r) meter_.emit("predict", nowMs());
    }
    return r; // nullptr while cold → the base loop yields (already period-paced)
  }

private:
  void setPeriodNs(double rateHz) {
    const double hz = clampRate(rateHz);
    periodNs_.store(static_cast<int64_t>(NS_PER_SEC / hz),
                    std::memory_order_release);
  }

  std::mutex mutex_;        // guards core_ + meter_ writes across the threads
  ImmCore core_;
  std::string name_;         // graph node id (declared BEFORE meter_ — init order)
  Meter::ThreadMeter meter_; // single logical writer per side, mutex-serialized
  ImmResult::Ptr lastIngest_; // most recent zero-coast result (mutex_)
  std::atomic<int64_t> periodNs_{1666666}; // ~600 Hz default
};

// --- convert helpers --------------------------------------------------------

template <> Napi::Value convert(Napi::Env env, const ImmResult::Ptr &r) noexcept {
  if (!r) return env.Null();
  auto o = Napi::Object::New(env);
  o.Set("found", Napi::Boolean::New(env, r->found));
  o.Set("overridden", Napi::Boolean::New(env, r->overridden));
  o.Set("coasting", Napi::Boolean::New(env, r->coasting));
  if (r->hasCenter) {
    auto c = Napi::Object::New(env);
    c.Set("x", Napi::Number::New(env, r->cx));
    c.Set("y", Napi::Number::New(env, r->cy));
    o.Set("center", c);
  } else {
    o.Set("center", env.Null());
  }
  if (r->hasBbox) {
    auto b = Napi::Object::New(env);
    b.Set("x", Napi::Number::New(env, r->bx));
    b.Set("y", Napi::Number::New(env, r->by));
    b.Set("width", Napi::Number::New(env, r->bw));
    b.Set("height", Napi::Number::New(env, r->bh));
    o.Set("bbox", b);
  } else {
    o.Set("bbox", env.Null());
  }
  o.Set("seq", Napi::Number::New(env, static_cast<double>(r->seq)));
  o.Set("deviceTimestamp", convert(env, r->deviceTimestamp));
  o.Set("propagatedToNs", convert(env, r->propagatedToNs));
  return o;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value &,
                    const ImmResult::Ptr &r) noexcept {
  return convert(env, r);
}

// Parse a JS TrackResult-shaped object into an ImmMeasurement.
static ImmMeasurement parseMeasurement(const Napi::Value &v) {
  ImmMeasurement m;
  auto o = v.As<Napi::Object>();
  m.found = o.Get("found").ToBoolean().Value();
  m.overridden = o.Has("overridden") && o.Get("overridden").ToBoolean().Value();
  const auto center = o.Get("center");
  if (center.IsObject()) {
    const auto c = center.As<Napi::Object>();
    m.cx = c.Get("x").ToNumber().DoubleValue();
    m.cy = c.Get("y").ToNumber().DoubleValue();
  }
  const auto bbox = o.Get("bbox");
  if (bbox.IsObject()) {
    const auto b = bbox.As<Napi::Object>();
    m.hasBbox = true;
    m.bx = b.Get("x").ToNumber().DoubleValue();
    m.by = b.Get("y").ToNumber().DoubleValue();
    m.bw = b.Get("width").ToNumber().DoubleValue();
    m.bh = b.Get("height").ToNumber().DoubleValue();
  }
  if (o.Has("seq")) m.seq = static_cast<uint64_t>(o.Get("seq").ToNumber().DoubleValue());
  if (o.Has("deviceTimestamp"))
    m.deviceTimestamp = convert<uint64_t>(o.Get("deviceTimestamp"));
  return m;
}

static Tuning parseTuning(const Napi::Object &o) {
  Tuning t;
  auto num = [&](const char *k, double &dst) {
    if (o.Has(k) && o.Get(k).IsNumber()) dst = o.Get(k).As<Napi::Number>().DoubleValue();
  };
  num("measurementVar", t.measurementVar);
  num("cvAccelPsd", t.cvAccelPsd);
  num("caJerkPsd", t.caJerkPsd);
  num("cpPosPsd", t.cpPosPsd);
  num("gate", t.gate);
  num("maxGapMs", t.maxGapMs);
  return t;
}

// ===========================================================================
// CoreObject wrapper: ingest / setParams / probe / [asyncIterator]. Create-only
// (via createImmPredictor).
// ===========================================================================
class ImmPredictorObject
    : public CoreObject<ImmPredictorObject, ImmStream::Ptr> {
public:
  static inline const std::string name = "ImmPredictor";
  static std::string describe(const ImmPredictorObject *) { return "ImmPredictor"; }

  static Napi::Function Init(Napi::Env env) {
    auto asyncIterator = Napi::Symbol::WellKnown(env, "asyncIterator");
    return DefineClass(
        env, name.c_str(),
        {
            CORE_OBJECT_REGISTER(ImmPredictorObject, env),
            INSTANCE_METHOD(ImmPredictorObject, ingest),
            INSTANCE_METHOD(ImmPredictorObject, lastIngest),
            INSTANCE_METHOD(ImmPredictorObject, setParams),
            INSTANCE_METHOD(ImmPredictorObject, probe),
            Napi::InstanceWrap<ImmPredictorObject>::template InstanceMethod<
                &ImmPredictorObject::asyncIterator>(asyncIterator),
            // native-port-pipe.md: the typed measurement IN port (lazily
            // created, cached). The disparity-scope session pipes the
            // tracker's track_out here — the JS measurement relay is gone.
            Napi::InstanceWrap<ImmPredictorObject>::template InstanceAccessor<
                &ImmPredictorObject::get_measure_in>("measure_in",
                                                     napi_enumerable),
        });
  }

  CORE_OBJECT_DECL(ImmPredictorObject)

  ImmPredictorObject(const Napi::CallbackInfo &info) : CoreObject(info) {}

  FN(ingest) {
    auto env = info.Env();
    try {
      return convert(env, core()->ingest(parseMeasurement(info[0])));
    }
    JS_EXCEPT(env.Undefined())
  }

  // The most recent zero-coast ingest result (NAPI ingest OR the measure_in
  // port — same path), or null before the first measurement. Test 42 compares
  // the piped conformance vectors through this observation point.
  FN(lastIngest) {
    auto env = info.Env();
    try {
      return convert(env, core()->lastIngest());
    }
    JS_EXCEPT(env.Undefined())
  }

  // `measure_in` — the typed measurement IN port (native-port-pipe.md). The
  // sink captures the ImmStream::Ptr, so a live link keeps the brick alive
  // even past a JS release of this wrapper; it runs on the LINK's delivery
  // thread and serializes on the brick's ingest mutex.
  GET(measure_in) {
    auto env = info.Env();
    try {
      if (measureIn_.IsEmpty()) {
        auto stream = core();
        auto port = PortPipe::makeInPort<TrackResult::Ptr>(
            stream->name(), "measure", "track",
            [stream](const TrackResult::Ptr &r) {
              if (r)
                stream->ingestFromPort(*r);
            });
        auto js = PortPipe::createInPortJs(env, port);
        measureIn_ = Napi::Persistent(js.As<Napi::Object>());
      }
      return measureIn_.Value();
    }
    JS_EXCEPT(env.Undefined())
  }

  // setParams({ rateHz?, delayMs? }) — live rate/delay change.
  FN(setParams) {
    auto env = info.Env();
    try {
      auto o = info[0].As<Napi::Object>();
      const bool hasRate = o.Has("rateHz") && o.Get("rateHz").IsNumber();
      const bool hasDelay = o.Has("delayMs") && o.Get("delayMs").IsNumber();
      const double rate = hasRate ? o.Get("rateHz").As<Napi::Number>().DoubleValue() : 0;
      const double delay = hasDelay ? o.Get("delayMs").As<Napi::Number>().DoubleValue() : 0;
      core()->setParams(hasRate, rate, hasDelay, delay);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(probe) {
    auto env = info.Env();
    try {
      return Arv::meterSnapshotToJs(env, core()->probe());
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(asyncIterator) {
    auto env = info.Env();
    try {
      auto stream = core().get();
      auto queue = Sub::Queue<ImmResult::Ptr>::create(stream);
      Napi::Value it =
          Sub::Iterator<Sub::Queue<ImmResult::Ptr>>::Create(env, queue);
      if (it.IsObject())
        it.As<Napi::Object>().Set("upstream", info.This());
      return it;
    }
    JS_EXCEPT(env.Undefined())
  }

private:
  Napi::ObjectReference measureIn_; // cached port wrapper (accessor contract)
};

CORE_OBJECT(ImmPredictorObject)

// Factory: createImmPredictor({ rateHz?, delayMs?, name?, ...tuning }) — the
// disparity-scope session creates one on tracking activation and feeds it every
// tracker result via `ingest`.
static FN(createImmPredictor) {
  auto env = info.Env();
  try {
    double rateHz = 600, delayMs = 0;
    std::string streamName = "imm";
    Tuning tuning;
    if (info.Length() >= 1 && info[0].IsObject()) {
      auto o = info[0].As<Napi::Object>();
      if (o.Has("rateHz") && o.Get("rateHz").IsNumber())
        rateHz = o.Get("rateHz").As<Napi::Number>().DoubleValue();
      if (o.Has("delayMs") && o.Get("delayMs").IsNumber())
        delayMs = o.Get("delayMs").As<Napi::Number>().DoubleValue();
      if (o.Has("name") && o.Get("name").IsString())
        streamName = o.Get("name").As<Napi::String>().Utf8Value();
      tuning = parseTuning(o);
    }
    auto stream = ImmStream::create(tuning, delayMs / 1000.0, rateHz,
                                    std::move(streamName));
    ImmStream::Ptr handle = stream;
    return ImmPredictorObject::Create(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// Joined into the Tracker namespace from Tracker.cpp's exportTrackerNamespace.
void exportImmNamespace(Napi::Env env, Napi::Object &exports) {
  ImmPredictorObject::Export(env, exports); // register the class for Create()
  exports.Set("createImmPredictor",
              Napi::Function::New<createImmPredictor>(env, "createImmPredictor"));
}
