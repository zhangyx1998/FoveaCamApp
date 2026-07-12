// Relay (Åström–Hägglund) auto-tune experiment — stage 1 of the vergence
// two-stage tune (docs/proposals/vergence-loop-tuning.md §1, spec
// docs/spec/disparity-scope.md#autotune). Pure state machine over synthetic
// plants: limit-cycle detection, bounded amplitude escalation, hard-timeout
// failure verdicts (never a throw), and the safety envelope (commands clamped
// to the DOF's physical limits, amplitude ≤ the configured cap).

import { describe, expect, it } from "vitest";
import {
  RelayExperiment,
  tyreusLuyben,
  type RelayOptions,
  type RelayVerdict,
} from "@modules/disparity-scope/relay-tune";

/** First-order lag + transport delay: the toy vergence plant (unit gain from
 *  DOF command to measurement; error = −measurement, setpoint 0). */
class LagDelayPlant {
  private y = 0;
  private u = 0;
  private line: number[] = [];
  constructor(
    private readonly tau: number,
    private readonly delay: number,
    private readonly gain = 1,
    private readonly map: (u: number) => number = (u) => u,
  ) {}
  command(v: number): void {
    this.u = v;
  }
  /** Advance one tick; returns the DELAYED measurement. */
  tick(): number {
    this.y += (this.gain * this.map(this.u) - this.y) / this.tau;
    this.line.push(this.y);
    return this.line.length > this.delay ? this.line.shift()! : 0;
  }
}

function runExperiment(
  plant: LagDelayPlant,
  opts: Partial<RelayOptions> & { noise?: (t: number) => number },
  maxTicks = 3000,
): { verdict: RelayVerdict | null; commands: number[] } {
  const commands: number[] = [];
  const exp = new RelayExperiment({
    center: 0,
    limits: [-1, 1],
    amplitude: 0.02,
    maxAmplitude: 0.1,
    ...opts,
    command: (v) => {
      plant.command(v);
      commands.push(v);
    },
  });
  let verdict: RelayVerdict | null = null;
  for (let t = 1; t <= maxTicks && !verdict; t++) {
    const y = plant.tick();
    verdict = exp.sample(t, -(y + (opts.noise?.(t) ?? 0)));
  }
  return { verdict, commands };
}

describe("RelayExperiment (limit-cycle detection on a lag+delay plant)", () => {
  it("finds a limit cycle and derives finite, positive Ku/Tu", () => {
    const { verdict, commands } = runExperiment(new LagDelayPlant(2, 3), {});
    expect(verdict).not.toBeNull();
    expect(verdict!.ok).toBe(true);
    if (!verdict!.ok) return;
    expect(Number.isFinite(verdict!.ku)).toBe(true);
    expect(verdict!.ku).toBeGreaterThan(0);
    // Period must at least span the transport delay round trip.
    expect(verdict!.tu).toBeGreaterThan(2 * 3);
    expect(verdict!.tu).toBeLessThan(100);
    // Safety envelope: every command within limits AND within the amplitude
    // cap about the center; the ORIGINAL center is restored at conclusion.
    for (const c of commands) {
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(1);
      expect(Math.abs(c)).toBeLessThanOrEqual(0.1 + 1e-12);
    }
    expect(commands[commands.length - 1]).toBe(0);
  });

  it("tolerates measurement noise through the hysteresis band", () => {
    const clean = runExperiment(new LagDelayPlant(2, 3), {}).verdict!;
    // Deterministic pseudo-noise well inside the hysteresis (0.15·d = 3e-3).
    const noisy = runExperiment(new LagDelayPlant(2, 3), {
      noise: (t) => 5e-4 * Math.sin(t * 2.399),
    }).verdict!;
    expect(clean.ok && noisy.ok).toBe(true);
    if (!clean.ok || !noisy.ok) return;
    expect(Math.abs(noisy.tu - clean.tu) / clean.tu).toBeLessThan(0.3);
  });

  it("escalates the amplitude (bounded) until a nonlinear plant oscillates", () => {
    // Quadratic-gain plant (the verge DOF's shape): too little loop gain at
    // the starting amplitude, plenty once escalated.
    const plant = new LagDelayPlant(2, 3, 1, (u) => 3 * u * Math.abs(u));
    const { verdict } = runExperiment(plant, {});
    expect(verdict!.ok).toBe(true);
    if (!verdict!.ok) return;
    expect(verdict!.amplitude).toBeGreaterThan(0.02); // escalated at least once
    expect(verdict!.amplitude).toBeLessThanOrEqual(0.1); // never past the cap
  });

  it("an overdamped/no-gain plant fails with a bounded verdict, never a throw", () => {
    // Tiny static gain: the oscillation can never clear the hysteresis band
    // (both scale with amplitude), so escalation is exhausted → verdict.
    const { verdict, commands } = runExperiment(
      new LagDelayPlant(2, 3, 0.02),
      { timeout: 1200 },
      3000,
    );
    expect(verdict).toEqual({ ok: false, reason: "no-oscillation" });
    for (const c of commands) expect(Math.abs(c)).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(commands[commands.length - 1]).toBe(0); // center restored on failure
  });

  it("rejects an under-resolved period (plant faster than the sample rate)", () => {
    // Instantaneous plant: the error flips every sample → half-period == one
    // sample interval → Tu below the resolvability floor.
    const plant = new LagDelayPlant(1, 0, 1);
    const { verdict } = runExperiment(plant, {});
    expect(verdict).toEqual({ ok: false, reason: "under-resolved" });
  });

  it("biases the relay center just inside a hard limit (one-sided DOF)", () => {
    // Center exactly ON the lower limit (the verge-at-infinity case): the
    // square wave must stay within [0, 1] yet remain two-sided about the
    // biased center.
    const plant = new LagDelayPlant(2, 3);
    const commands: number[] = [];
    const exp = new RelayExperiment({
      center: 0,
      limits: [0, 1],
      amplitude: 0.02,
      maxAmplitude: 0.1,
      command: (v) => {
        plant.command(v);
        commands.push(v);
      },
    });
    let verdict: RelayVerdict | null = null;
    for (let t = 1; t <= 3000 && !verdict; t++) verdict = exp.sample(t, -plant.tick());
    for (const c of commands) expect(c).toBeGreaterThanOrEqual(0);
    expect(new Set(commands).size).toBeGreaterThan(1); // genuinely two-sided
    expect(commands[commands.length - 1]).toBe(0); // original center restored
  });

  it("samples after conclusion are inert (verdict retained, no commands)", () => {
    const plant = new LagDelayPlant(2, 3);
    const commands: number[] = [];
    const exp = new RelayExperiment({
      center: 0,
      limits: [-1, 1],
      amplitude: 0.02,
      maxAmplitude: 0.1,
      command: (v) => {
        plant.command(v);
        commands.push(v);
      },
    });
    let verdict: RelayVerdict | null = null;
    for (let t = 1; t <= 3000 && !verdict; t++) verdict = exp.sample(t, -plant.tick());
    expect(exp.done).toBe(true);
    const n = commands.length;
    expect(exp.sample(9999, 0.5)).toBeNull();
    expect(commands.length).toBe(n);
    expect(exp.verdict).toEqual(verdict);
  });
});

describe("tyreusLuyben (ultimate gain/period → conservative PID gains)", () => {
  it("matches the tabulated relations kp = Ku/2.2, ki = kp/(2.2 Tu), kd = kp Tu/6.3", () => {
    const g = tyreusLuyben(10, 5);
    expect(g.kp).toBeCloseTo(10 / 2.2);
    expect(g.ki).toBeCloseTo(10 / 2.2 / (2.2 * 5));
    expect(g.kd).toBeCloseTo(((10 / 2.2) * 5) / 6.3);
  });

  it("all gains scale linearly with Ku and stay positive", () => {
    const a = tyreusLuyben(1, 8);
    const b = tyreusLuyben(3, 8);
    expect(b.kp / a.kp).toBeCloseTo(3);
    expect(b.ki / a.ki).toBeCloseTo(3);
    expect(b.kd / a.kd).toBeCloseTo(3);
    expect(a.kp).toBeGreaterThan(0);
    expect(a.ki).toBeGreaterThan(0);
    expect(a.kd).toBeGreaterThan(0);
  });
});
