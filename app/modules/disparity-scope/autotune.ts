// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Two-stage vergence auto-tune run — the phase state machine the session feeds
// with match-pair samples (docs/proposals/vergence-loop-tuning.md §1, ruled:
// relay first stage → optional CMA-ES joint polish, session-driven,
// drawer-gated, never automatic). PURE over injected hooks: the session owns
// pose/gain application; every terminal path is a callback, never a throw.
// RIG-GATED: real experiments; simulation only smoke-tests the optimizer.
// Behavior spec: docs/spec/disparity-scope.md#autotune.

import { RelayExperiment, tyreusLuyben, type RelayVerdict } from "./relay-tune";
import { CmaEs, fromLogSpace, toLogSpace } from "./cma-es";
import {
  regulationCost,
  stepCost,
  MIN_TRACE_SAMPLES,
  UNMEASURABLE_COST,
  type StepTraceSample,
} from "./step-cost";

export type DofName = "panX" | "panY" | "verge" | "v_shift";
export const DOF_ORDER: readonly DofName[] = ["panX", "panY", "verge", "v_shift"];
export type DofErrors = Record<DofName, number>;

export type GainTriple = [number, number, number];
/** kp/ki/kd per tuning group — mirrors the contract `Tuning` gain subset. */
export type GainSet = { pan: GainTriple; depth: GainTriple; v_shift: GainTriple };

export type AutotuneStage = "relay" | "full";
export type AutotunePhase = "relay" | "eval" | "done" | "failed" | "aborted";

export type AutotuneProgress = {
  phase: AutotunePhase;
  stage: AutotuneStage;
  /** Relay: the DOF under experiment. */
  dof: DofName | null;
  dofsDone: number;
  /** Relay: consistent cycles observed so far on the current DOF. */
  cycles: number;
  /** Eval: candidates scored / total budget (incl. baseline + seed). */
  evals: number;
  budget: number;
  bestCost: number | null;
  /** Cost of the PRE-TUNE gains under the same protocol (comparison anchor). */
  baselineCost: number | null;
  message: string | null;
  /** Final gains on `done`. */
  gains: GainSet | null;
};

export type FeedSample = {
  /** Tune-clock time in loop-dt units (strictly increasing). */
  t: number;
  /** Per-DOF `setpoint − measurement` errors from the current match pair. */
  errors: DofErrors;
  /** Both match scores cleared `min_score` — untrusted samples are skipped. */
  scoreOk: boolean;
};

/** What the session should do with THIS control tick:
 *  - `hold`  — keep the held volts (terminal, or waiting);
 *  - `drive` — a relay command moved a DOF: reposition via the follow map;
 *  - `step`  — eval running: step the real control law at the candidate gains. */
export type FeedDirective = { mode: "hold" | "drive" | "step" };

export interface AutotuneDof {
  get(): number;
  /** Clamped to the DOF's physical range by the owner. */
  set(v: number): void;
  range: [number, number];
}

export interface AutotuneHooks {
  dof: Record<DofName, AutotuneDof>;
  /** Apply a candidate gain set to the LIVE controllers (not persisted). */
  applyGains(g: GainSet): void;
  /** Scripted step: offset the target by `px` along +x from the tune base. */
  setTargetOffset(px: number): void;
  progress(p: AutotuneProgress): void;
  finished(o: {
    phase: "done" | "failed" | "aborted";
    gains: GainSet | null;
    message: string | null;
  }): void;
}

export interface AutotuneOptions {
  /** Pre-tune gains: the eval baseline AND the fallback for failed DOFs. */
  initialGains: GainSet;
  /** Relay start half-amplitude as a fraction of the DOF range. */
  amplitudeRatio?: number;
  /** Hard cap on the relay half-amplitude fraction. */
  maxAmplitudeRatio?: number;
  cyclesRequired?: number;
  /** Relay per-level baseline window (loop-dt units, like every time below). */
  settleTime?: number;
  levelTimeout?: number;
  /** Per-DOF hard relay budget → failure verdict. */
  dofTimeout?: number;
  /** Eval: settle window before each scripted step. */
  evalSettle?: number;
  /** Eval: recorded window after each scripted step. */
  evalWindow?: number;
  /** CMA-ES candidate budget (baseline + seed evals ride on top). */
  evalBudget?: number;
  /** Scripted target step (px along +x). */
  stepPx?: number;
  /** Log-space box half-width around the relay seed (decades). */
  boundsDecades?: number;
  seed?: number;
  /** Tune-clock value at run start (feeds the starvation watchdog). */
  startT?: number;
  /** No trusted sample for this long → the run fails closed. */
  starveTimeout?: number;
}

const OPT_DEFAULTS = {
  amplitudeRatio: 0.02,
  maxAmplitudeRatio: 0.1,
  cyclesRequired: 3,
  settleTime: 30,
  levelTimeout: 300,
  dofTimeout: 1200,
  evalSettle: 90,
  evalWindow: 240,
  evalBudget: 48,
  stepPx: 40,
  boundsDecades: 1,
  seed: 1,
  startT: 0,
  starveTimeout: 600,
} as const;

/** Cross-coupling weight on the non-stepped DOFs' regulation cost. */
const EVAL_REG_WEIGHT = 1;

const DOF_GROUP: Record<DofName, keyof GainSet> = {
  panX: "pan",
  panY: "pan",
  verge: "depth",
  v_shift: "v_shift",
};

export function cloneGains(g: GainSet): GainSet {
  return { pan: [...g.pan], depth: [...g.depth], v_shift: [...g.v_shift] };
}

/** Merge per-DOF relay verdicts into a gain set: pan takes the elementwise MIN
 *  of its two axes' triples (conservative), a failed DOF keeps its initial
 *  triple. Exported for tests. */
export function mergeRelayGains(
  initial: GainSet,
  results: Partial<Record<DofName, { kp: number; ki: number; kd: number }>>,
): GainSet {
  const triple = (r: { kp: number; ki: number; kd: number }): GainTriple => [
    r.kp,
    r.ki,
    r.kd,
  ];
  const merged = cloneGains(initial);
  const px = results.panX;
  const py = results.panY;
  if (px && py)
    merged.pan = [
      Math.min(px.kp, py.kp),
      Math.min(px.ki, py.ki),
      Math.min(px.kd, py.kd),
    ];
  else if (px || py) merged.pan = triple((px ?? py)!);
  if (results.verge) merged.depth = triple(results.verge);
  if (results.v_shift) merged.v_shift = triple(results.v_shift);
  return merged;
}

export function gainsToVector(g: GainSet): number[] {
  return [...g.pan, ...g.depth, ...g.v_shift];
}

export function vectorToGains(v: readonly number[]): GainSet {
  return {
    pan: [v[0]!, v[1]!, v[2]!],
    depth: [v[3]!, v[4]!, v[5]!],
    v_shift: [v[6]!, v[7]!, v[8]!],
  };
}

type EvalCandidate = {
  kind: "baseline" | "seed" | "cma";
  x: readonly number[] | null;
  gains: GainSet;
  settleUntil: number;
  jumped: boolean;
  jumpT: number;
  recordUntil: number;
  trace: Record<DofName, StepTraceSample[]>;
};

export class AutotuneRun {
  private readonly o: Required<AutotuneOptions>;
  private readonly p: AutotuneProgress;
  private terminal = false;
  private lastFeedT: number;
  private lastGoodT: number;

  // relay stage
  private dofIdx = 0;
  private exp: RelayExperiment | null = null;
  private readonly relayGains: Partial<
    Record<DofName, { kp: number; ki: number; kd: number }>
  > = {};
  private readonly relayFailures: {
    dof: DofName;
    reason: Extract<RelayVerdict, { ok: false }>["reason"];
  }[] = [];

  // eval stage
  private cma: CmaEs | null = null;
  private seedGains: GainSet | null = null;
  private specials: ("baseline" | "seed")[] = [];
  private current: EvalCandidate | null = null;
  private offset = 0;
  private bestGains: GainSet | null = null;

  constructor(
    readonly stage: AutotuneStage,
    private readonly hooks: AutotuneHooks,
    opts: AutotuneOptions,
  ) {
    this.o = { ...OPT_DEFAULTS, ...opts };
    this.lastFeedT = this.o.startT;
    this.lastGoodT = this.o.startT;
    this.p = {
      phase: "relay",
      stage,
      dof: DOF_ORDER[0]!,
      dofsDone: 0,
      cycles: 0,
      evals: 0,
      budget: stage === "full" ? this.o.evalBudget + 2 : 0,
      bestCost: null,
      baselineCost: null,
      message: null,
      gains: null,
    };
    hooks.progress({ ...this.p });
  }

  get done(): boolean {
    return this.terminal;
  }

  /** True when no sample arrived for `starveTimeout` — the session's watchdog
   *  polls this out-of-loop (a dead match feed would otherwise wedge the run). */
  starved(t: number): boolean {
    return !this.terminal && t - this.lastFeedT > this.o.starveTimeout;
  }

  abort(reason: string): void {
    if (this.terminal) return;
    this.finish("aborted", null, reason);
  }

  /** Fail the run closed (the session's starvation watchdog): a dead match
   *  feed is a FAILURE — "aborted" means user action everywhere else. */
  fail(message: string): void {
    if (this.terminal) return;
    this.finish("failed", null, message);
  }

  feed(s: FeedSample): FeedDirective {
    if (this.terminal) return { mode: "hold" };
    this.lastFeedT = s.t;
    if (s.scoreOk) this.lastGoodT = s.t;
    else if (s.t - this.lastGoodT > this.o.starveTimeout) {
      this.finish("failed", null, "no trusted matches (score below min)");
      return { mode: "hold" };
    }
    return this.p.phase === "relay" ? this.feedRelay(s) : this.feedEval(s);
  }

  private publish(patch: Partial<AutotuneProgress>): void {
    Object.assign(this.p, patch);
    this.hooks.progress({ ...this.p });
  }

  private finish(
    phase: "done" | "failed" | "aborted",
    gains: GainSet | null,
    message: string | null,
  ): void {
    this.terminal = true;
    this.publish({ phase, gains, message, dof: null });
    this.hooks.finished({ phase, gains, message });
  }

  // --- relay stage ---------------------------------------------------------

  private feedRelay(s: FeedSample): FeedDirective {
    const dof = DOF_ORDER[this.dofIdx]!;
    if (!this.exp) {
      const d = this.hooks.dof[dof];
      const range = d.range[1] - d.range[0];
      this.exp = new RelayExperiment({
        center: d.get(),
        limits: d.range,
        amplitude: this.o.amplitudeRatio * range,
        maxAmplitude: this.o.maxAmplitudeRatio * range,
        command: (v) => d.set(v),
        cyclesRequired: this.o.cyclesRequired,
        settleTime: this.o.settleTime,
        levelTimeout: this.o.levelTimeout,
        timeout: this.o.dofTimeout,
      });
      this.publish({ dof, cycles: 0 });
    }
    if (!s.scoreOk) return { mode: "drive" }; // hold the pose, clock still runs
    const verdict = this.exp.sample(s.t, s.errors[dof]);
    if (this.exp.cycles !== this.p.cycles) this.publish({ cycles: this.exp.cycles });
    if (verdict) {
      if (verdict.ok) this.relayGains[dof] = tyreusLuyben(verdict.ku, verdict.tu);
      else this.relayFailures.push({ dof, reason: verdict.reason });
      this.exp = null;
      this.dofIdx++;
      this.publish({
        dofsDone: this.dofIdx,
        dof: DOF_ORDER[this.dofIdx] ?? null,
        cycles: 0,
      });
      if (this.dofIdx >= DOF_ORDER.length) this.finishRelay();
    }
    return { mode: "drive" };
  }

  /** Per-DOF failure verdicts, human-readable — the reason (and the
   *  near-target hint for a verge that would not cycle: at ∞/parallel the
   *  depth axis has nothing to push against) must reach the status line. */
  private relayFailureList(): string | null {
    if (!this.relayFailures.length) return null;
    const label = {
      "no-oscillation": "no oscillation",
      timeout: "no stable cycle in time",
      "under-resolved": "cycle faster than the match rate",
    } as const;
    return this.relayFailures
      .map(({ dof, reason }) => {
        const hint =
          dof === "verge" && reason !== "under-resolved"
            ? " — try a nearer target"
            : "";
        return `${dof}: ${label[reason]}${hint}`;
      })
      .join("; ");
  }

  private relayMessage(): string | null {
    const list = this.relayFailureList();
    return list ? `kept prior gains for ${list}` : null;
  }

  private finishRelay(): void {
    if (this.relayFailures.length >= DOF_ORDER.length) {
      this.finish(
        "failed",
        null,
        `relay failed on every DOF (${this.relayFailureList()})`,
      );
      return;
    }
    const merged = mergeRelayGains(this.o.initialGains, this.relayGains);
    if (this.stage === "relay") {
      this.hooks.applyGains(merged);
      this.finish("done", merged, this.relayMessage());
      return;
    }
    this.seedGains = merged;
    const x0 = toLogSpace(gainsToVector(merged));
    this.cma = new CmaEs({
      x0,
      sigma0: this.o.boundsDecades / 3,
      lo: x0.map((v) => v - this.o.boundsDecades),
      hi: x0.map((v) => v + this.o.boundsDecades),
      seed: this.o.seed,
      maxEvals: this.o.evalBudget,
    });
    this.specials = ["baseline", "seed"];
    this.publish({ phase: "eval", dof: null, cycles: 0 });
  }

  // --- eval stage (CMA-ES joint polish) --------------------------------------

  private startNextCandidate(t: number): boolean {
    let kind: EvalCandidate["kind"];
    let x: readonly number[] | null = null;
    let gains: GainSet;
    const special = this.specials.shift();
    if (special) {
      kind = special;
      gains = special === "baseline" ? this.o.initialGains : this.seedGains!;
    } else {
      const batch = this.cma!.ask();
      if (batch.length === 0) {
        this.finishEval();
        return false;
      }
      kind = "cma";
      x = batch[0]!;
      gains = vectorToGains(fromLogSpace(x));
    }
    this.hooks.applyGains(gains);
    this.current = {
      kind,
      x,
      gains,
      settleUntil: t + this.o.evalSettle,
      jumped: false,
      jumpT: 0,
      recordUntil: 0,
      trace: { panX: [], panY: [], verge: [], v_shift: [] },
    };
    return true;
  }

  private candidateCost(c: EvalCandidate): number {
    if (c.trace.panX.length < MIN_TRACE_SAMPLES) return UNMEASURABLE_COST;
    const base = stepCost(c.trace.panX);
    let peak = 0;
    for (const s of c.trace.panX) peak = Math.max(peak, Math.abs(s.error));
    let reg = 0;
    for (const dof of DOF_ORDER)
      if (dof !== "panX") reg += regulationCost(c.trace[dof], peak);
    return base + EVAL_REG_WEIGHT * reg;
  }

  private feedEval(s: FeedSample): FeedDirective {
    if (!this.current && !this.startNextCandidate(s.t)) return { mode: "hold" };
    const c = this.current!;
    if (s.t < c.settleUntil) return { mode: "step" };
    if (!c.jumped) {
      c.jumped = true;
      this.offset = this.offset === 0 ? this.o.stepPx : 0;
      this.hooks.setTargetOffset(this.offset);
      c.jumpT = s.t;
      c.recordUntil = s.t + this.o.evalWindow;
      return { mode: "step" };
    }
    if (s.t < c.recordUntil) {
      if (s.scoreOk)
        for (const dof of DOF_ORDER)
          c.trace[dof].push({
            t: s.t - c.jumpT,
            error: s.errors[dof],
            command: this.hooks.dof[dof].get(),
          });
      return { mode: "step" };
    }
    const cost = this.candidateCost(c);
    this.current = null;
    if (c.kind === "baseline") {
      this.publish({ evals: this.p.evals + 1, baselineCost: cost });
      return { mode: "step" };
    }
    if (c.kind === "cma") this.cma!.tell(c.x!, cost);
    if (cost < (this.p.bestCost ?? Infinity)) {
      this.bestGains = c.gains;
      this.publish({ evals: this.p.evals + 1, bestCost: cost });
    } else {
      this.publish({ evals: this.p.evals + 1 });
    }
    if (this.specials.length === 0 && this.cma!.done) {
      // Terminal restore just ran — hold this tick rather than stepping the
      // restored controllers against the stale projection.
      this.finishEval();
      return { mode: "hold" };
    }
    return { mode: "step" };
  }

  private finishEval(): void {
    // The seed is always evaluated before any CMA candidate, so `bestGains`
    // can only be null on an unmeasurable protocol — fall back to the seed.
    const best = this.bestGains ?? this.seedGains!;
    this.hooks.applyGains(best);
    this.hooks.setTargetOffset(0);
    this.offset = 0;
    this.finish("done", best, this.relayMessage());
  }
}
