// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Relay (Åström–Hägglund) auto-tune experiment — PURE single-DOF state machine
// (stage 1 of the two-stage tune, docs/proposals/vergence-loop-tuning.md §1).
// Drives one DOF with a ±amplitude square wave about its current value through
// the supplied `command` callback, detects the induced limit cycle from the
// (t, error) sample stream, and derives ultimate gain/period → Tyreus–Luyben
// velocity-form gains. Every failure mode is a VERDICT, never an exception.
// Behavior spec: docs/spec/disparity-scope.md#autotune.

import { clamp } from "@lib/util/math";

export interface RelayOptions {
  /** DOF value the experiment oscillates about (restored on any conclusion). */
  center: number;
  /** Hard physical DOF range — commands NEVER leave it. */
  limits: [number, number];
  /** Initial relay half-amplitude (DOF units). */
  amplitude: number;
  /** Hard cap on the half-amplitude (escalation never exceeds it). */
  maxAmplitude: number;
  /** Apply a DOF command (the caller repositions the pose after `sample`). */
  command: (value: number) => void;
  /** Amplitude multiplier when no limit cycle emerges at the current level. */
  escalation?: number;
  /** Consistent FULL cycles required to conclude (2× half-cycles measured). */
  cyclesRequired?: number;
  /** Relative spread tolerated across the concluding half-cycles. */
  tolerance?: number;
  /** Switching hysteresis as a fraction of the current amplitude (assumes the
   *  near-unity DOF→error static gain of the vergence decomposition). */
  hysteresisRatio?: number;
  /** Absolute hysteresis override (error units) — wins over the ratio. */
  hysteresis?: number;
  /** Baseline window re-run per amplitude level: the error mean over it
   *  becomes the oscillation reference (absorbs a biased center). */
  settleTime?: number;
  /** Budget per amplitude level before escalating. */
  levelTimeout?: number;
  /** Total experiment budget (same time units as `sample`'s `t`). */
  timeout?: number;
  /** Concluded Tu below this many mean sample intervals is under-resolved. */
  minPeriodSamples?: number;
}

export type RelayVerdict =
  | {
      ok: true;
      /** Ultimate gain `4d / (π a)` (d = relay half-amplitude, a = error
       *  oscillation half-amplitude about the settle reference). */
      ku: number;
      /** Ultimate period (units of the sample timestamps). */
      tu: number;
      /** The half-amplitude that produced the limit cycle. */
      amplitude: number;
      /** Full cycles the conclusion averaged over. */
      cycles: number;
    }
  | { ok: false; reason: "no-oscillation" | "timeout" | "under-resolved" };

const DEFAULTS = {
  escalation: 2,
  cyclesRequired: 3,
  tolerance: 0.35,
  hysteresisRatio: 0.15,
  settleTime: 30,
  levelTimeout: 300,
  timeout: 1200,
  minPeriodSamples: 3,
} as const;

/** Relative spread `(max − min) / mean` of a positive sequence. */
function spread(values: number[]): number {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    sum += v;
  }
  const mean = sum / values.length;
  return mean > 0 ? (hi - lo) / mean : Infinity;
}

export class RelayExperiment {
  private readonly o: Required<Omit<RelayOptions, "hysteresis">> & {
    hysteresis?: number;
  };
  private phase: "settle" | "relay" | "done" = "settle";
  private t0: number | null = null;
  private levelStart = 0;
  private settleEnd = 0;
  private eRefSum = 0;
  private eRefN = 0;
  private eRef = 0;
  /** Current half-amplitude (escalates, capped at `maxAmplitude`). */
  private d: number;
  /** Center biased just inside a hard limit so the square wave stays symmetric. */
  private effCenter: number;
  private relaySign: 0 | 1 | -1 = 0;
  private lastSwitchT = 0;
  private peak = 0;
  private halfCycles: { period: number; amp: number }[] = [];
  private switches = 0;
  private prevT: number | null = null;
  private intervalSum = 0;
  private intervalN = 0;
  private _verdict: RelayVerdict | null = null;

  constructor(opts: RelayOptions) {
    this.o = { ...DEFAULTS, ...opts };
    this.d = Math.min(opts.amplitude, opts.maxAmplitude);
    this.effCenter = this.biasedCenter();
  }

  /** Consistent half-cycle pairs observed at the current level (progress). */
  get cycles(): number {
    return this.halfCycles.length >> 1;
  }

  get done(): boolean {
    return this.phase === "done";
  }

  get verdict(): RelayVerdict | null {
    return this._verdict;
  }

  private biasedCenter(): number {
    const [lo, hi] = this.o.limits;
    return clamp(this.o.center, [Math.min(lo + this.d, hi), Math.max(hi - this.d, lo)]);
  }

  private hyst(): number {
    return this.o.hysteresis ?? this.o.hysteresisRatio * this.d;
  }

  private commandClamped(value: number): void {
    this.o.command(clamp(value, this.o.limits));
  }

  private startSettle(t: number): void {
    this.phase = "settle";
    this.settleEnd = t + this.o.settleTime;
    this.eRefSum = 0;
    this.eRefN = 0;
    this.halfCycles = [];
    this.relaySign = 0;
    this.levelStart = t;
    this.commandClamped(this.effCenter);
  }

  private conclude(v: RelayVerdict): RelayVerdict {
    this.phase = "done";
    this._verdict = v;
    this.commandClamped(this.o.center); // always restore the original value
    return v;
  }

  /**
   * Feed one sample (`t` strictly increasing, `error` = setpoint − measurement
   * for the driven DOF). Applies relay commands through `command` as a side
   * effect; returns the verdict once concluded, else null.
   */
  sample(t: number, error: number): RelayVerdict | null {
    if (this.phase === "done") return null;
    if (this.t0 === null) {
      this.t0 = t;
      this.prevT = t;
      this.startSettle(t);
      return null;
    }
    if (this.prevT !== null && t > this.prevT) {
      this.intervalSum += t - this.prevT;
      this.intervalN++;
    }
    this.prevT = t;

    if (t - this.t0 > this.o.timeout)
      return this.conclude({
        ok: false,
        reason: this.switches < 3 ? "no-oscillation" : "timeout",
      });

    if (this.phase === "settle") {
      this.eRefSum += error;
      this.eRefN++;
      if (t >= this.settleEnd) {
        this.eRef = this.eRefN > 0 ? this.eRefSum / this.eRefN : 0;
        this.phase = "relay";
        this.lastSwitchT = t;
        this.peak = 0;
      }
      return null;
    }

    const e = error - this.eRef;
    this.peak = Math.max(this.peak, Math.abs(e));
    const h = this.hyst();
    let want = this.relaySign;
    if (e > h) want = 1;
    else if (e < -h) want = -1;
    if (this.relaySign === 0) {
      // Kick the plant to get moving; an in-band error defaults positive.
      this.relaySign = want === 0 ? 1 : want;
      this.commandClamped(this.effCenter + this.d * this.relaySign);
      this.lastSwitchT = t;
      this.peak = 0;
    } else if (want !== this.relaySign) {
      this.halfCycles.push({ period: t - this.lastSwitchT, amp: this.peak });
      this.switches++;
      this.relaySign = want;
      this.commandClamped(this.effCenter + this.d * want);
      this.lastSwitchT = t;
      this.peak = 0;
      const need = 2 * this.o.cyclesRequired;
      const recent = this.halfCycles.slice(-need);
      if (recent.length >= need) {
        const periods = recent.map((c) => c.period);
        const amps = recent.map((c) => c.amp);
        if (
          spread(periods) <= this.o.tolerance &&
          spread(amps) <= this.o.tolerance
        ) {
          const tu = (2 * periods.reduce((a, b) => a + b, 0)) / periods.length;
          const a = amps.reduce((x, y) => x + y, 0) / amps.length;
          const meanInterval =
            this.intervalN > 0 ? this.intervalSum / this.intervalN : Infinity;
          if (tu < this.o.minPeriodSamples * meanInterval)
            return this.conclude({ ok: false, reason: "under-resolved" });
          if (!(a > 0)) return this.conclude({ ok: false, reason: "no-oscillation" });
          return this.conclude({
            ok: true,
            ku: (4 * this.d) / (Math.PI * a),
            tu,
            amplitude: this.d,
            cycles: this.o.cyclesRequired,
          });
        }
      }
    }

    // No conclusion at this level within its budget → escalate (bounded).
    if (t - this.levelStart > this.o.levelTimeout && this.d < this.o.maxAmplitude) {
      this.d = Math.min(this.d * this.o.escalation, this.o.maxAmplitude);
      this.effCenter = this.biasedCenter();
      this.startSettle(t);
    }
    return null;
  }
}

/** Tyreus–Luyben PID gains from the ultimate gain/period (parallel form:
 *  `kp·e + ki·∫e + kd·de` — the shape `@lib/pid` integrates). Conservative by
 *  design: Kc = Ku/2.2, τI = 2.2·Tu, τD = Tu/6.3. */
export function tyreusLuyben(
  ku: number,
  tu: number,
): { kp: number; ki: number; kd: number } {
  const kp = ku / 2.2;
  return { kp, ki: kp / (2.2 * tu), kd: (kp * tu) / 6.3 };
}
