import type { Point2d } from "core/Geometry";

type Sample = { t: number; x: number; y: number };

function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++)
      if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
    [M[i], M[p]] = [M[p], M[i]];
    const piv = M[i][i];
    if (Math.abs(piv) < 1e-12) return null;
    for (let c = i; c <= n; c++) M[i][c] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = M[r][i];
      for (let c = i; c <= n; c++) M[r][c] -= f * M[i][c];
    }
  }
  return M.map((row) => row[n]);
}

function fitPoly(t: number[], y: number[], order: number): number[] | null {
  const n = t.length;
  const m = order + 1;
  const S = new Array(2 * m - 1).fill(0);
  for (let i = 0; i < n; i++) {
    let tk = 1;
    for (let k = 0; k < 2 * m - 1; k++) {
      S[k] += tk;
      tk *= t[i];
    }
  }
  const A: number[][] = Array.from({ length: m }, (_, j) =>
    Array.from({ length: m }, (_, k) => S[j + k]),
  );
  const b = new Array(m).fill(0);
  for (let i = 0; i < n; i++) {
    let tk = 1;
    for (let k = 0; k < m; k++) {
      b[k] += tk * y[i];
      tk *= t[i];
    }
  }
  return solveLinear(A, b);
}

function evalPoly(c: number[], t: number): number {
  let r = 0;
  for (let i = c.length - 1; i >= 0; i--) r = r * t + c[i];
  return r;
}

// Buffers recent (t, x, y) samples and predicts (x, y) at a query time
// via least-squares polynomial fit. Order is auto-selected from sample
// count and capped at cubic to avoid noise amplification.
export class KinematicModel {
  private samples: Sample[] = [];
  private readonly getMax: () => number;

  constructor(getMax: () => number) {
    this.getMax = getMax;
  }

  push(x: number, y: number, t: number) {
    this.samples.push({ t, x, y });
    const max = Math.max(1, Math.round(this.getMax()));
    if (this.samples.length > max)
      this.samples.splice(0, this.samples.length - max);
  }

  predict(targetT: number): Point2d | null {
    const N = this.samples.length;
    if (N === 0) return null;
    if (N === 1) return { x: this.samples[0].x, y: this.samples[0].y };
    const order = Math.min(3, N - 1);
    // Normalize time around the most recent sample for numerical stability.
    const tRef = this.samples[N - 1].t;
    let tScale = 0;
    for (const s of this.samples)
      tScale = Math.max(tScale, Math.abs(s.t - tRef));
    if (tScale === 0) tScale = 1;
    const tn = this.samples.map((s) => (s.t - tRef) / tScale);
    const xs = this.samples.map((s) => s.x);
    const ys = this.samples.map((s) => s.y);
    const cx = fitPoly(tn, xs, order);
    const cy = fitPoly(tn, ys, order);
    const last = this.samples[N - 1];
    if (!cx || !cy) return { x: last.x, y: last.y };
    const tt = (targetT - tRef) / tScale;
    return { x: evalPoly(cx, tt), y: evalPoly(cy, tt) };
  }

  reset() {
    this.samples = [];
  }
}
