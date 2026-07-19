// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Minimal dependency-free (μ/μ_w, λ)-CMA-ES over a bounded vector — stage 2 of
// the two-stage vergence tune.
// Asynchronous evaluation contract: `ask()` exposes the current generation's
// candidates, `tell(candidate, cost)` scores one; the distribution updates when
// the generation completes. Deterministic under the seeded xorshift RNG.
// Gains ride in log10 space (helpers below) so a ±1-decade bound is a box.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal deviate. */
  gauss(): number;
}

/** Tiny deterministic xorshift32 PRNG + Box–Muller gaussians (no deps). */
export function xorshift(seed: number): Rng {
  let s = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  let spare: number | null = null;
  return {
    next,
    gauss() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u = 0;
      while (u === 0) u = next(); // log(0) guard
      const r = Math.sqrt(-2 * Math.log(u));
      const th = 2 * Math.PI * next();
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    },
  };
}

export const GAIN_LOG_FLOOR = 1e-5;

/** Gains → log10 space (floored so a zero gain stays representable). */
export function toLogSpace(g: readonly number[], floor = GAIN_LOG_FLOOR): number[] {
  return g.map((v) => Math.log10(Math.max(v, floor)));
}

export function fromLogSpace(x: readonly number[]): number[] {
  return x.map((v) => 10 ** v);
}

export interface CmaOptions {
  /** Initial mean (e.g. the relay-seeded gains in log space). */
  x0: readonly number[];
  /** Initial step size (same space as `x0`). */
  sigma0: number;
  /** Box bounds — every asked candidate is clipped into them. */
  lo: readonly number[];
  hi: readonly number[];
  /** Population size (default `4 + ⌊3 ln n⌋`). */
  lambda?: number;
  /** RNG seed (deterministic runs). */
  seed?: number;
  /** Evaluation budget — `done` once this many candidates were told. */
  maxEvals: number;
}

/** Symmetric eigendecomposition by cyclic Jacobi (n ≤ ~12 here — cheap).
 *  Returns eigenvectors as COLUMNS of `v` and eigenvalues in `d`. */
function jacobiEigen(input: number[][]): { v: number[][]; d: number[] } {
  const n = input.length;
  const a = input.map((row) => row.slice());
  const v: number[][] = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { v, d: a.map((row, i) => row[i]!) };
}

export class CmaEs {
  private readonly n: number;
  readonly lambda: number;
  private readonly mu: number;
  private readonly weights: number[];
  private readonly mueff: number;
  private readonly cs: number;
  private readonly ds: number;
  private readonly cc: number;
  private readonly c1: number;
  private readonly cmu: number;
  private readonly chiN: number;
  private readonly lo: readonly number[];
  private readonly hi: readonly number[];
  private readonly maxEvals: number;
  private readonly rng: Rng;

  private m: number[];
  private sigma: number;
  private C: number[][];
  private B: number[][];
  private D: number[];
  private ps: number[];
  private pc: number[];
  private gen = 0;

  private pending: number[][] = [];
  private told: { x: number[]; cost: number }[] = [];
  private evalCount = 0;
  private bestX: number[] | null = null;
  private bestCost = Infinity;

  constructor(opts: CmaOptions) {
    const n = (this.n = opts.x0.length);
    this.lambda = opts.lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const raw = Array.from({ length: this.mu }, (_, i) =>
      Math.log((this.lambda + 1) / 2) - Math.log(i + 1),
    );
    const sum = raw.reduce((a, b) => a + b, 0);
    this.weights = raw.map((w) => w / sum);
    this.mueff =
      1 / this.weights.reduce((a, w) => a + w * w, 0);
    this.cs = (this.mueff + 2) / (n + this.mueff + 5);
    this.ds =
      1 +
      2 * Math.max(0, Math.sqrt((this.mueff - 1) / (n + 1)) - 1) +
      this.cs;
    this.cc = (4 + this.mueff / n) / (n + 4 + (2 * this.mueff) / n);
    this.c1 = 2 / ((n + 1.3) ** 2 + this.mueff);
    this.cmu = Math.min(
      1 - this.c1,
      (2 * (this.mueff - 2 + 1 / this.mueff)) / ((n + 2) ** 2 + this.mueff),
    );
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.lo = opts.lo;
    this.hi = opts.hi;
    this.maxEvals = opts.maxEvals;
    this.rng = xorshift(opts.seed ?? 1);
    this.m = [...opts.x0];
    this.sigma = opts.sigma0;
    this.C = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
    this.B = this.C.map((r) => r.slice());
    this.D = Array(n).fill(1);
    this.ps = Array(n).fill(0);
    this.pc = Array(n).fill(0);
  }

  get evals(): number {
    return this.evalCount;
  }

  get done(): boolean {
    return this.evalCount >= this.maxEvals;
  }

  get best(): { x: number[]; cost: number } | null {
    return this.bestX ? { x: [...this.bestX], cost: this.bestCost } : null;
  }

  /** The current generation's un-told candidates (samples a fresh generation
   *  when none are pending). Empty once the budget is spent. */
  ask(): readonly (readonly number[])[] {
    if (this.done) return [];
    if (this.pending.length === 0 && this.told.length === 0) {
      for (let k = 0; k < this.lambda; k++) {
        const z = Array.from({ length: this.n }, () => this.rng.gauss());
        const x = this.m.map((mi, i) => {
          let y = 0;
          for (let j = 0; j < this.n; j++)
            y += this.B[i]![j]! * this.D[j]! * z[j]!;
          const v = mi + this.sigma * y;
          return Math.min(this.hi[i]!, Math.max(this.lo[i]!, v));
        });
        this.pending.push(x);
      }
    }
    return this.pending;
  }

  /** Score one candidate from `ask()` (reference or value match). The
   *  distribution updates once the whole generation is told. */
  tell(x: readonly number[], cost: number): void {
    let idx = this.pending.indexOf(x as number[]);
    if (idx < 0)
      idx = this.pending.findIndex(
        (p) => p.length === x.length && p.every((v, i) => v === x[i]),
      );
    if (idx < 0) throw new Error("cma-es: candidate not pending");
    this.pending.splice(idx, 1);
    this.told.push({ x: [...x], cost });
    this.evalCount++;
    if (cost < this.bestCost) {
      this.bestCost = cost;
      this.bestX = [...x];
    }
    if (this.pending.length === 0 && this.told.length >= this.lambda)
      this.update();
  }

  private update(): void {
    const n = this.n;
    this.gen++;
    const sorted = [...this.told].sort((a, b) => a.cost - b.cost);
    this.told = [];
    const mOld = this.m;
    const m = Array(n).fill(0);
    for (let i = 0; i < this.mu; i++)
      for (let j = 0; j < n; j++) m[j] += this.weights[i]! * sorted[i]!.x[j]!;
    this.m = m;
    const yw = m.map((v, i) => (v - mOld[i]!) / this.sigma);
    // C^(-1/2)·yw = B·diag(1/D)·Bᵀ·yw
    const bty = Array(n).fill(0);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) bty[j] += this.B[i]![j]! * yw[i]!;
    const csn = Math.sqrt(this.cs * (2 - this.cs) * this.mueff);
    const white = Array(n).fill(0);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        white[i] += (this.B[i]![j]! * bty[j]!) / Math.max(this.D[j]!, 1e-20);
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + csn * white[i]!);
    const psNorm = Math.hypot(...this.ps);
    const hsig =
      psNorm / Math.sqrt(1 - (1 - this.cs) ** (2 * this.gen)) / this.chiN <
      1.4 + 2 / (n + 1)
        ? 1
        : 0;
    const ccn = Math.sqrt(this.cc * (2 - this.cc) * this.mueff);
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * ccn * yw[i]!);
    const c1a = this.c1 * (1 - (1 - hsig) * this.cc * (2 - this.cc));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let rankMu = 0;
        for (let k = 0; k < this.mu; k++) {
          const yi = (sorted[k]!.x[i]! - mOld[i]!) / this.sigma;
          const yj = (sorted[k]!.x[j]! - mOld[j]!) / this.sigma;
          rankMu += this.weights[k]! * yi * yj;
        }
        this.C[i]![j] =
          (1 - c1a - this.cmu) * this.C[i]![j]! +
          this.c1 * this.pc[i]! * this.pc[j]! +
          this.cmu * rankMu;
      }
    }
    // Enforce symmetry against drift before decomposing.
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const s = (this.C[i]![j]! + this.C[j]![i]!) / 2;
        this.C[i]![j] = s;
        this.C[j]![i] = s;
      }
    this.sigma *= Math.exp((this.cs / this.ds) * (psNorm / this.chiN - 1));
    const { v, d } = jacobiEigen(this.C);
    this.B = v;
    this.D = d.map((e) => Math.sqrt(Math.max(e, 1e-20)));
  }
}
