// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// IMM (Interacting Multiple Model) Kalman motion predictor chained after the
// disparity-scope tracker: wraps each TrackResult to output the target's estimated
// position at `t_result + delayMs` (lead > 0, lag < 0, passthrough at 0). Three
// dynamics models (CP/CV/CA) over a shared per-axis [pos,vel,acc] state; axes
// filtered independently but the teleport/re-arm gate fires jointly. Pure scalar
// math (types-only core imports); unit-tested.
// spec: docs/spec/vision.md#imm-predictor

import type { TrackResult } from "core/Tracker";
import type { Point2d, Rect } from "core/Geometry";

const NS_PER_SEC = 1e9;

/** Which of the three dynamics models an IMM instance runs (default: all). A
 *  single-element set collapses the IMM to a plain KF — used by the tests to
 *  contrast a pure-CA filter's overshoot against the full IMM. */
export type ImmModelKind = "cp" | "cv" | "ca";

export interface ImmPredictorConfig {
  /** Signed delay compensation, MILLISECONDS. 0 = exact passthrough (the
   *  predictor is inert; `process` returns its argument unchanged). */
  delayMs: number;
  /** Measurement noise variance R (px²). Default 4 (≈2 px std). */
  measurementVar?: number;
  /** White-noise-acceleration PSD for the CV model (px²/s³). Default 400. */
  cvAccelPsd?: number;
  /** White-noise-jerk PSD for the CA model (px²/s⁵). Default 5000. */
  caJerkPsd?: number;
  /** Random-walk position PSD for the CP model (px²/s). Default 1. */
  cpPosPsd?: number;
  /** Joint innovation gate (χ², 2 dof) beyond which a measurement is treated
   *  as a discontinuity (teleport / re-arm) → reinit AT the measurement rather
   *  than dragging the estimate. Default 30 (~grossly-outlying only). */
  gate?: number;
  /** dt above this (ms) is a re-acquire, not a step: reset at the measurement
   *  instead of propagating over a huge gap. Default 500. */
  maxGapMs?: number;
  /** Model subset (default all three). */
  models?: ImmModelKind[];
}

type Vec = number[];
type Mat = number[][];

// --- tiny dense linear algebra (≤3×3, explicit) ------------------------------

function matVec(A: Mat, x: Vec): Vec {
  const n = A.length;
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += A[i][j] * x[j];
    out[i] = s;
  }
  return out;
}

function matMat(A: Mat, B: Mat): Mat {
  const n = A.length;
  const out: Mat = [];
  for (let i = 0; i < n; i++) {
    out[i] = new Array<number>(n).fill(0);
    for (let k = 0; k < n; k++) {
      const aik = A[i][k];
      if (aik === 0) continue;
      for (let j = 0; j < n; j++) out[i][j] += aik * B[k][j];
    }
  }
  return out;
}

function transpose(A: Mat): Mat {
  const n = A.length;
  const out: Mat = [];
  for (let i = 0; i < n; i++) {
    out[i] = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) out[i][j] = A[j][i];
  }
  return out;
}

/** Symmetrize in place — kills the round-off asymmetry KF updates accrue. */
function symmetrize(A: Mat): Mat {
  const n = A.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const m = 0.5 * (A[i][j] + A[j][i]);
      A[i][j] = A[j][i] = m;
    }
  return A;
}

function isFiniteVec(x: Vec): boolean {
  for (const v of x) if (!Number.isFinite(v)) return false;
  return true;
}
function isFiniteMat(A: Mat): boolean {
  for (const row of A) if (!isFiniteVec(row)) return false;
  return true;
}

// --- one dynamics model (shared 3-state space [pos, vel, acc]) ---------------

interface Model {
  kind: ImmModelKind;
  /** State transition for a step of `dt` seconds. */
  F(dt: number): Mat;
  /** Discrete process-noise covariance for a step of `dt` seconds. */
  Q(dt: number): Mat;
}

/** Tiny diagonal floor so a model whose F collapses a dimension keeps a
 *  non-singular covariance (avoids a degenerate mix / division). */
const FLOOR = 1e-3;

function makeModels(cfg: Required<Pick<ImmPredictorConfig,
  "cvAccelPsd" | "caJerkPsd" | "cpPosPsd">>, kinds: ImmModelKind[]): Model[] {
  const cp: Model = {
    kind: "cp",
    F: () => [
      [1, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
    Q: (dt) => [
      [cfg.cpPosPsd * dt, 0, 0],
      [0, FLOOR, 0],
      [0, 0, FLOOR],
    ],
  };
  const cv: Model = {
    kind: "cv",
    F: (dt) => [
      [1, dt, 0],
      [0, 1, 0],
      [0, 0, 0],
    ],
    // Continuous white-noise-acceleration discretized over [p, v]; acc floored.
    Q: (dt) => {
      const q = cfg.cvAccelPsd;
      const d2 = dt * dt;
      const d3 = d2 * dt;
      return [
        [(q * d3) / 3, (q * d2) / 2, 0],
        [(q * d2) / 2, q * dt, 0],
        [0, 0, FLOOR],
      ];
    },
  };
  const ca: Model = {
    kind: "ca",
    F: (dt) => [
      [1, dt, 0.5 * dt * dt],
      [0, 1, dt],
      [0, 0, 1],
    ],
    // Continuous white-noise-jerk discretized over [p, v, a].
    Q: (dt) => {
      const q = cfg.caJerkPsd;
      const d2 = dt * dt;
      const d3 = d2 * dt;
      const d4 = d3 * dt;
      const d5 = d4 * dt;
      return [
        [(q * d5) / 20, (q * d4) / 8, (q * d3) / 6],
        [(q * d4) / 8, (q * d3) / 3, (q * d2) / 2],
        [(q * d3) / 6, (q * d2) / 2, q * dt],
      ];
    },
  };
  const all = { cp, cv, ca };
  return kinds.map((k) => all[k]);
}

/** Default transition matrix for the 3-model set (rows i→cols j, self-biased);
 *  sub-matrices are renormalized when a model subset is used. */
const FULL_TRANSITION: Record<ImmModelKind, Record<ImmModelKind, number>> = {
  cp: { cp: 0.94, cv: 0.05, ca: 0.01 },
  cv: { cp: 0.05, cv: 0.9, ca: 0.05 },
  ca: { cp: 0.01, cv: 0.09, ca: 0.9 },
};
const INITIAL_PROB: Record<ImmModelKind, number> = { cp: 0.2, cv: 0.6, ca: 0.2 };

/** Initial per-axis covariance for a (re)init at a measurement: tight on
 *  position (we trust the measurement), broad on the unobserved vel/acc. */
function initCovariance(measurementVar: number): Mat {
  return [
    [measurementVar, 0, 0],
    [0, 1e4, 0],
    [0, 0, 1e6],
  ];
}

// --- per-axis IMM ------------------------------------------------------------

class AxisImm {
  private readonly models: Model[];
  private readonly nm: number;
  private readonly trans: Mat; // renormalized transition, [i][j]
  private readonly R: number;
  private readonly measurementVar: number;
  /** Per-model state + covariance. */
  private xs: Vec[];
  private Ps: Mat[];
  /** Model probabilities. */
  private mu: Vec;
  /** Predicted model probabilities c̄_j from the last mixing (for gating). */
  private cbar: Vec;

  constructor(models: Model[], trans: Mat, mu0: Vec, R: number) {
    this.models = models;
    this.nm = models.length;
    this.trans = trans;
    this.R = R;
    this.measurementVar = R;
    this.mu = mu0.slice();
    this.cbar = mu0.slice();
    this.xs = [];
    this.Ps = [];
  }

  /** (Re)initialize every model at position `p` (zero vel/acc), reset probs. */
  reset(p: number, mu0: Vec): void {
    this.xs = [];
    this.Ps = [];
    for (let j = 0; j < this.nm; j++) {
      this.xs.push([p, 0, 0]);
      this.Ps.push(initCovariance(this.measurementVar));
    }
    this.mu = mu0.slice();
    this.cbar = mu0.slice();
  }

  /** Combined (IMM) state estimate [pos, vel, acc]. */
  combinedState(): Vec {
    const x: Vec = [0, 0, 0];
    for (let j = 0; j < this.nm; j++)
      for (let k = 0; k < 3; k++) x[k] += this.mu[j] * this.xs[j][k];
    return x;
  }

  /** Combined position variance (mixture moment) — test hook for the
   *  covariance-growth assertions across a measurement gap. */
  combinedPosVar(): number {
    const p = this.combinedState()[0];
    let v = 0;
    for (let j = 0; j < this.nm; j++) {
      const d = this.xs[j][0] - p;
      v += this.mu[j] * (this.Ps[j][0][0] + d * d);
    }
    return v;
  }

  /** Mixing + per-model predict over `dt`. Returns the predicted per-model
   *  states/covariances left in `xs`/`Ps`, having also cached `cbar`. */
  private predict(dt: number): void {
    // --- interaction / mixing ---
    // c̄_j = Σ_i p_ij μ_i ; μ_{i|j} = p_ij μ_i / c̄_j
    const cbar: Vec = new Array<number>(this.nm).fill(0);
    for (let j = 0; j < this.nm; j++)
      for (let i = 0; i < this.nm; i++) cbar[j] += this.trans[i][j] * this.mu[i];
    this.cbar = cbar;

    const mixedX: Vec[] = [];
    const mixedP: Mat[] = [];
    for (let j = 0; j < this.nm; j++) {
      const x0: Vec = [0, 0, 0];
      for (let i = 0; i < this.nm; i++) {
        const w = cbar[j] > 0 ? (this.trans[i][j] * this.mu[i]) / cbar[j] : 0;
        for (let k = 0; k < 3; k++) x0[k] += w * this.xs[i][k];
      }
      const P0: Mat = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let i = 0; i < this.nm; i++) {
        const w = cbar[j] > 0 ? (this.trans[i][j] * this.mu[i]) / cbar[j] : 0;
        const d = [
          this.xs[i][0] - x0[0],
          this.xs[i][1] - x0[1],
          this.xs[i][2] - x0[2],
        ];
        for (let a = 0; a < 3; a++)
          for (let b = 0; b < 3; b++)
            P0[a][b] += w * (this.Ps[i][a][b] + d[a] * d[b]);
      }
      mixedX.push(x0);
      mixedP.push(P0);
    }

    // --- per-model predict ---
    for (let j = 0; j < this.nm; j++) {
      const F = this.models[j].F(dt);
      const Q = this.models[j].Q(dt);
      const x = matVec(F, mixedX[j]);
      const FP = matMat(F, mixedP[j]);
      const P = matMat(FP, transpose(F));
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++) P[a][b] += Q[a][b];
      symmetrize(P);
      this.xs[j] = x;
      this.Ps[j] = P;
    }
  }

  /** Combined predicted measurement + its variance (mixture moment) — the
   *  quantities the joint innovation gate consumes. Call AFTER `predict`. */
  private predictedMeasurement(): { z: number; S: number } {
    let z = 0;
    for (let j = 0; j < this.nm; j++) z += this.cbar[j] * this.xs[j][0];
    let S = 0;
    for (let j = 0; j < this.nm; j++) {
      const d = this.xs[j][0] - z;
      S += this.cbar[j] * (this.Ps[j][0][0] + d * d);
    }
    return { z, S: S + this.R };
  }

  /** Per-model KF update against scalar measurement `z` (H = [1,0,0]), then
   *  the IMM probability update. */
  private update(z: number): void {
    const like: Vec = new Array<number>(this.nm).fill(0);
    for (let j = 0; j < this.nm; j++) {
      const x = this.xs[j];
      const P = this.Ps[j];
      const y = z - x[0]; // innovation (H picks position)
      const S = P[0][0] + this.R; // innovation variance (scalar)
      // Kalman gain K = P Hᵀ / S = P[:,0] / S.
      const K = [P[0][0] / S, P[1][0] / S, P[2][0] / S];
      x[0] += K[0] * y;
      x[1] += K[1] * y;
      x[2] += K[2] * y;
      // P = (I - K H) P ; K H has its non-zero column at index 0.
      const newP: Mat = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++) newP[a][b] = P[a][b] - K[a] * P[0][b];
      symmetrize(newP);
      this.Ps[j] = newP;
      like[j] =
        Math.exp(-0.5 * (y * y) / S) / Math.sqrt(2 * Math.PI * S);
    }
    // μ_j = c̄_j Λ_j / Σ ; fall back to c̄ if all likelihoods underflow.
    let sum = 0;
    const mu: Vec = new Array<number>(this.nm).fill(0);
    for (let j = 0; j < this.nm; j++) {
      mu[j] = this.cbar[j] * like[j];
      sum += mu[j];
    }
    if (sum > 0) for (let j = 0; j < this.nm; j++) mu[j] /= sum;
    else mu.splice(0, this.nm, ...this.cbar);
    this.mu = mu;
  }

  /** No-measurement step (found=false): keep the predicted models, roll the
   *  model probabilities forward to the predicted `cbar` (uncertainty grows via
   *  the predicted covariances — no correction is applied). */
  private noUpdate(): void {
    let sum = 0;
    for (const c of this.cbar) sum += c;
    this.mu = sum > 0 ? this.cbar.map((c) => c / sum) : this.mu;
  }

  /**
   * Advance by `dt` seconds. `z` = the measured position (found), or null (a
   * miss → predict-only). Returns the pre-update combined measurement + its
   * variance so the caller can evaluate the JOINT gate before committing.
   */
  step(dt: number, z: number | null): { predZ: number; predS: number } {
    this.predict(dt);
    const pred = this.predictedMeasurement();
    if (z === null) this.noUpdate();
    else this.update(z);
    return { predZ: pred.z, predS: pred.S };
  }

  /** True when any per-model state/covariance went non-finite. */
  degenerate(): boolean {
    for (let j = 0; j < this.nm; j++)
      if (!isFiniteVec(this.xs[j]) || !isFiniteMat(this.Ps[j])) return true;
    return false;
  }
}

// --- propagation of a combined state by the delay ----------------------------

/** Propagate a combined per-axis state [p, v, a] by `dt` seconds using full
 *  kinematics (works for a signed dt — negative retrodicts). This does NOT run
 *  the filter; it advances the single best estimate, per the sign
 *  convention (+ = forward / lead, − = backward / lag). */
function propagatePos(state: Vec, dt: number): number {
  return state[0] + state[1] * dt + 0.5 * state[2] * dt * dt;
}

// --- the predictor -----------------------------------------------------------

/** A free-run (coasting) prediction off {@link ImmPredictor.predictAfter} —
 *  the TS mirror of the native brick's `ImmResult` emit shape (minus the
 *  wall-clock `measuredAtNs` stamp, which is native-side metadata; the pure
 *  reference is driven by explicit coast offsets instead of a clock). */
export interface ImmCoastPrediction {
  found: boolean;
  overridden: boolean;
  coasting: boolean;
  center: Point2d | null;
  bbox: Rect | null;
  seq: number;
  deviceTimestamp: bigint;
}

export class ImmPredictor {
  private readonly delaySec: number;
  private readonly gate: number;
  private readonly maxGapSec: number;
  private readonly mu0: Vec;
  private readonly makeAxis: () => AxisImm;
  private ax!: AxisImm;
  private ay!: AxisImm;
  private lastTs: bigint | null = null;
  private warm = false;
  // Free-run mirror state: the native brick's lastWasMiss_/lastMeas_ pair,
  // tracked so `predictAfter` reproduces the brick's coast-cap semantics
  // exactly.
  private lastWasMiss = false;
  private lastMeas: TrackResult | null = null;

  constructor(cfg: ImmPredictorConfig) {
    this.delaySec = cfg.delayMs / 1000;
    this.gate = cfg.gate ?? 30;
    this.maxGapSec = (cfg.maxGapMs ?? 500) / 1000;
    const kinds = cfg.models ?? ["cp", "cv", "ca"];
    const R = cfg.measurementVar ?? 4;
    const models = makeModels(
      {
        cvAccelPsd: cfg.cvAccelPsd ?? 400,
        caJerkPsd: cfg.caJerkPsd ?? 5000,
        cpPosPsd: cfg.cpPosPsd ?? 1,
      },
      kinds,
    );
    // Renormalize the transition sub-matrix + initial probs to the model subset.
    const trans: Mat = kinds.map((i) => {
      const row = kinds.map((j) => FULL_TRANSITION[i][j]);
      const s = row.reduce((a, b) => a + b, 0);
      return row.map((v) => (s > 0 ? v / s : 1 / kinds.length));
    });
    const rawMu0 = kinds.map((k) => INITIAL_PROB[k]);
    const muSum = rawMu0.reduce((a, b) => a + b, 0);
    this.mu0 = rawMu0.map((v) => v / muSum);
    this.makeAxis = () => new AxisImm(models, trans, this.mu0, R);
    this.reset();
  }

  /** Combined position variance per axis [varX, varY] — a TEST hook for the
   *  gap covariance-growth assertions (grows on predict-only misses, shrinks on
   *  a measurement update). */
  debugPosVar(): [number, number] {
    return [this.ax.combinedPosVar(), this.ay.combinedPosVar()];
  }

  /** Clear all dynamics — the next result reinitializes at its measurement.
   *  Called on construction, on an override (drag teleports the target), on a
   *  huge gap, on a gated discontinuity, and on any numerical degeneracy. */
  reset(): void {
    this.ax = this.makeAxis();
    this.ay = this.makeAxis();
    this.lastTs = null;
    this.warm = false;
    this.lastWasMiss = false;
  }

  /**
   * Free-run prediction `coastMs` after the last processed result — the TS
   * mirror of the native brick's `predictAt`/`predictAfter`.
   * Null while cold. A miss-coast (last result was a miss) OR
   * a coast past `maxGapMs` — the CAP: a stalled source must degrade to
   * the miss-coast shape (found=false, coasting=true) instead of
   * extrapolating the CA state quadratically forever — returns no center;
   * otherwise the combined estimate propagates by `coast + delay`.
   */
  predictAfter(coastMs: number): ImmCoastPrediction | null {
    if (!this.warm) return null;
    const coastSec = coastMs / 1000;
    const m = this.lastMeas;
    if (this.lastWasMiss || coastSec > this.maxGapSec) {
      return {
        found: false,
        overridden: false,
        coasting: true,
        center: null,
        bbox: null,
        seq: m?.seq ?? 0,
        deviceTimestamp: m?.deviceTimestamp ?? 0n,
      };
    }
    const delta = (coastSec > 0 ? coastSec : 0) + this.delaySec;
    const px = propagatePos(this.ax.combinedState(), delta);
    const py = propagatePos(this.ay.combinedState(), delta);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      // Mirror the native non-finite escape: reset + passthrough of the last
      // measurement (never emit a poisoned center).
      this.reset();
      return m
        ? {
            found: m.found,
            overridden: m.overridden,
            coasting: false,
            center: m.center,
            bbox: m.bbox,
            seq: m.seq,
            deviceTimestamp: m.deviceTimestamp,
          }
        : null;
    }
    const shiftX = m?.center ? px - m.center.x : 0;
    const shiftY = m?.center ? py - m.center.y : 0;
    return {
      found: true,
      overridden: false,
      coasting: coastSec > 0,
      center: { x: px, y: py },
      bbox: m?.bbox
        ? {
            x: m.bbox.x + shiftX,
            y: m.bbox.y + shiftY,
            width: m.bbox.width,
            height: m.bbox.height,
          }
        : null,
      seq: m?.seq ?? 0,
      deviceTimestamp: m?.deviceTimestamp ?? 0n,
    };
  }

  /**
   * Run one tracker result through the predictor.
   *
   *  - `delayMs === 0` → the argument is returned UNCHANGED (exact passthrough).
   *  - OVERRIDDEN (drag) → passthrough + RESET (a drag teleports the target;
   *    resuming from stale dynamics would yank the mirrors).
   *  - found=false (miss) → predict-only (covariance grows), the result is
   *    passed through UNCHANGED — the downstream lost-gate owns the policy.
   *  - found + warm → `center` is replaced by the state propagated to
   *    `t_result + delayMs`, and `bbox` is shifted by the same delta (size
   *    preserved); `found`/`seq`/`deviceTimestamp`/`overridden` preserved.
   *
   * On the first result, a gated discontinuity, a huge gap, dt ≤ 0, or any
   * numerical degeneracy the filter reinitializes at the measurement and the
   * result passes through unchanged.
   */
  process(r: TrackResult): TrackResult {
    if (this.delaySec === 0) return r; // exact passthrough — inert.

    if (r.overridden) {
      this.reset();
      this.lastMeas = r; // native storeMeas parity (predictAfter shape source)
      return r;
    }

    const ts = r.deviceTimestamp;

    // Miss: no measurement — advance predict-only to grow uncertainty, keep the
    // filter's clock, and pass the (found=false, center=null) result through.
    if (!r.found || !r.center) {
      this.lastWasMiss = true; // native parity: predictAfter miss-coasts
      this.lastMeas = r;
      if (this.lastTs !== null && this.warm) {
        const dt = Number(ts - this.lastTs) / NS_PER_SEC;
        if (dt > 0 && dt <= this.maxGapSec) {
          this.ax.step(dt, null);
          this.ay.step(dt, null);
          this.lastTs = ts;
          if (this.ax.degenerate() || this.ay.degenerate()) this.reset();
        } else if (dt > this.maxGapSec) {
          this.reset();
        }
      }
      return r;
    }

    const z = r.center;
    this.lastMeas = r; // native storeMeas parity

    // First result (cold) or after a reset: (re)init at the measurement.
    if (this.lastTs === null) {
      this.ax.reset(z.x, this.mu0);
      this.ay.reset(z.y, this.mu0);
      this.lastTs = ts;
      this.warm = true;
      this.lastWasMiss = false;
      return r;
    }

    const dt = Number(ts - this.lastTs) / NS_PER_SEC;
    // Non-positive dt (duplicate / out-of-order stamp) or a huge gap: don't
    // propagate — reinit at the measurement (gap) or leave the estimate and
    // pass through (dt ≤ 0). Either way the mirrors never lurch on bad time.
    if (dt <= 0) return r;
    if (dt > this.maxGapSec) {
      this.ax.reset(z.x, this.mu0);
      this.ay.reset(z.y, this.mu0);
      this.lastTs = ts;
      this.warm = true;
      this.lastWasMiss = false;
      return r;
    }

    // Step both axes; evaluate the JOINT innovation gate on the pre-update
    // prediction. Above the gate the measurement is a discontinuity (teleport /
    // re-arm) → reinit at the measurement rather than dragging the estimate.
    const gx = this.ax.step(dt, z.x);
    const gy = this.ay.step(dt, z.y);
    const dx = z.x - gx.predZ;
    const dy = z.y - gy.predZ;
    const d2 =
      (gx.predS > 0 ? (dx * dx) / gx.predS : 0) +
      (gy.predS > 0 ? (dy * dy) / gy.predS : 0);
    if (d2 > this.gate) {
      this.ax.reset(z.x, this.mu0);
      this.ay.reset(z.y, this.mu0);
      this.lastTs = ts;
      this.warm = true;
      this.lastWasMiss = false;
      return r;
    }

    this.lastTs = ts;
    this.lastWasMiss = false;

    // Any NaN escape → reset + passthrough (never emit a poisoned center).
    if (this.ax.degenerate() || this.ay.degenerate()) {
      this.reset();
      return r;
    }

    // Propagate the combined estimate by the (signed) delay and shift.
    const sx = this.ax.combinedState();
    const sy = this.ay.combinedState();
    const px = propagatePos(sx, this.delaySec);
    const py = propagatePos(sy, this.delaySec);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      this.reset();
      return r;
    }
    const center: Point2d = { x: px, y: py };
    const shiftX = px - z.x;
    const shiftY = py - z.y;
    const bbox: Rect | null = r.bbox
      ? {
          x: r.bbox.x + shiftX,
          y: r.bbox.y + shiftY,
          width: r.bbox.width,
          height: r.bbox.height,
        }
      : r.bbox;
    return {
      found: r.found,
      overridden: r.overridden,
      center,
      bbox,
      seq: r.seq,
      deviceTimestamp: r.deviceTimestamp,
    };
  }
}

/** Whether a configured delay makes the predictor do anything (session uses
 *  this to decide whether to construct + wire the node at all). */
export function delayIsActive(delayMs: number | null | undefined): boolean {
  return typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs !== 0;
}
