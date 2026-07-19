// Minimal (μ/μ_w, λ)-CMA-ES — stage 2 of the vergence two-stage tune
// Pure optimizer conformance:
// convergence on sphere + Rosenbrock within budget, bound respect, and
// determinism under the seeded RNG (the asynchronous ask/tell contract the
// session's eval protocol drives).

import { describe, expect, it } from "vitest";
import {
  CmaEs,
  fromLogSpace,
  toLogSpace,
  xorshift,
  GAIN_LOG_FLOOR,
  type CmaOptions,
} from "@modules/disparity-scope/cma-es";

function optimize(
  fn: (x: readonly number[]) => number,
  opts: CmaOptions,
  onAsk?: (x: readonly number[]) => void,
): { x: number[]; cost: number } {
  const cma = new CmaEs(opts);
  while (!cma.done) {
    const batch = [...cma.ask()];
    if (batch.length === 0) break;
    for (const x of batch) {
      onAsk?.(x);
      cma.tell(x, fn(x));
    }
  }
  return cma.best!;
}

const sphere = (x: readonly number[]): number =>
  x.reduce((a, v) => a + v * v, 0);

const rosenbrock = (x: readonly number[]): number => {
  let c = 0;
  for (let i = 0; i < x.length - 1; i++)
    c += 100 * (x[i + 1]! - x[i]! ** 2) ** 2 + (1 - x[i]!) ** 2;
  return c;
};

describe("CmaEs (convergence within budget)", () => {
  it("solves a 6-D sphere from an offset start", () => {
    const best = optimize(sphere, {
      x0: [2, 2, 2, 2, 2, 2],
      sigma0: 1,
      lo: Array(6).fill(-10),
      hi: Array(6).fill(10),
      seed: 42,
      maxEvals: 3000,
    });
    expect(best.cost).toBeLessThan(1e-6);
  });

  it("solves a 4-D Rosenbrock valley (the joint-polish shape: coupled, non-convex)", () => {
    const best = optimize(rosenbrock, {
      x0: [-1, -1, -1, -1],
      sigma0: 0.5,
      lo: Array(4).fill(-5),
      hi: Array(4).fill(5),
      seed: 7,
      maxEvals: 8000,
    });
    expect(best.cost).toBeLessThan(1e-2);
    for (const v of best.x) expect(Math.abs(v - 1)).toBeLessThan(0.2);
  });
});

describe("CmaEs (bounds + budget + contract)", () => {
  it("every asked candidate respects the box bounds; the best lands on the active bound", () => {
    // Optimum (3,3) OUTSIDE the box [−1, 1]²: the best feasible point is the
    // corner (1,1).
    const shifted = (x: readonly number[]): number =>
      (x[0]! - 3) ** 2 + (x[1]! - 3) ** 2;
    const best = optimize(
      shifted,
      {
        x0: [0, 0],
        sigma0: 0.5,
        lo: [-1, -1],
        hi: [1, 1],
        seed: 3,
        maxEvals: 600,
      },
      (x) => {
        for (const v of x) {
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      },
    );
    expect(best.x[0]).toBeCloseTo(1, 3);
    expect(best.x[1]).toBeCloseTo(1, 3);
  });

  it("stops asking at the evaluation budget", () => {
    const cma = new CmaEs({
      x0: [0, 0],
      sigma0: 1,
      lo: [-5, -5],
      hi: [5, 5],
      seed: 1,
      maxEvals: 10,
    });
    let evals = 0;
    while (!cma.done) {
      const batch = [...cma.ask()];
      for (const x of batch) {
        cma.tell(x, sphere(x));
        evals++;
      }
    }
    expect(evals).toBeGreaterThanOrEqual(10);
    expect(cma.ask()).toEqual([]);
    expect(cma.evals).toBe(evals);
  });

  it("tell() rejects a candidate that was never asked", () => {
    const cma = new CmaEs({
      x0: [0],
      sigma0: 1,
      lo: [-1],
      hi: [1],
      seed: 1,
      maxEvals: 10,
    });
    cma.ask();
    expect(() => cma.tell([0.123456], 1)).toThrow(/not pending/);
  });

  it("is deterministic per seed", () => {
    const run = (seed: number) =>
      optimize(sphere, {
        x0: [1, 1, 1],
        sigma0: 0.7,
        lo: [-4, -4, -4],
        hi: [4, 4, 4],
        seed,
        maxEvals: 300,
      });
    const a = run(11);
    const b = run(11);
    expect(a.x).toEqual(b.x);
    expect(a.cost).toBe(b.cost);
    const c = run(12);
    expect(c.x).not.toEqual(a.x); // a different stream, not a constant
  });
});

describe("xorshift RNG + log-space helpers", () => {
  it("produces a deterministic uniform stream in [0, 1)", () => {
    const a = xorshift(99);
    const b = xorshift(99);
    for (let i = 0; i < 100; i++) {
      const v = a.next();
      expect(v).toBe(b.next());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gaussians have sane first moments", () => {
    const rng = xorshift(1234);
    let sum = 0;
    let sq = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) {
      const g = rng.gauss();
      sum += g;
      sq += g * g;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
    expect(sq / N).toBeGreaterThan(0.9);
    expect(sq / N).toBeLessThan(1.1);
  });

  it("log-space transform round-trips positive gains and floors zeros", () => {
    const g = [0.02, 1.0, 0.5];
    expect(fromLogSpace(toLogSpace(g)).map((v) => +v.toFixed(12))).toEqual(g);
    expect(fromLogSpace(toLogSpace([0]))[0]).toBeCloseTo(GAIN_LOG_FLOOR);
  });
});
