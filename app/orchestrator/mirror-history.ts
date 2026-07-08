// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Short memory of mirror positions vs host time
// (docs/proposals/unified-time-and-topology.md §4). The fovea/L-R undistort
// homography needs the mirror position AT THE FRAME'S (past) exposure time —
// commands are issued up to ~1 kHz while frames arrive at ~60 fps, so the
// orchestrator keeps a small ring of {hostNs, left, right} and answers
// `mirrorAt(hostNs)` with linear interpolation between the two neighbors.
//
// Writers (see actuation.ts): every SENT stream update records its
// `predictVolts` result; awaited `actuate()` records the readback. Honesty
// note (proposal §4): these are COMMANDS — the physical mirror follows with
// LPF group delay (~1.3 ms at the 120 Hz LPF) + settle; triggered captures
// should prefer the FIN exposure-averaged voltage when present (P4).

import type { Pos } from "@lib/controller-codec";

export interface MirrorSample {
  hostNs: bigint;
  left: Pos;
  right: Pos;
}

export interface MirrorAt {
  left: Pos;
  right: Pos;
  /** Distance from the query instant to the nearest recorded sample —
   *  the staleness/confidence signal (≥0; huge = extrapolating). */
  ageNs: bigint;
  /** False when the query landed outside the recorded span (clamped to the
   *  nearest endpoint instead of interpolated). */
  interpolated: boolean;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpPos = (a: Pos, b: Pos, t: number): Pos => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
});

/** Fixed-capacity ring, monotonic-time append. 4096 ≈ 4 s at the 1 kHz
 *  stream-update ceiling — comfortably longer than any frame latency. */
export class MirrorHistory {
  private readonly ring: MirrorSample[];
  private head = 0; // next write slot
  private count = 0;

  constructor(readonly capacity = 4096) {
    this.ring = new Array<MirrorSample>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Append a sample. Out-of-order timestamps (clock hiccup) are dropped —
   *  the ring must stay monotonic for the binary search. */
  record(hostNs: bigint, left: Pos, right: Pos): void {
    const newest = this.at(-1);
    if (newest && hostNs < newest.hostNs) return;
    this.ring[this.head] = {
      hostNs,
      left: { x: left.x, y: left.y },
      right: { x: right.x, y: right.y },
    };
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** i = 0 oldest … count-1 newest (negative = from the end). */
  private at(i: number): MirrorSample | null {
    if (this.count === 0) return null;
    const idx = i < 0 ? this.count + i : i;
    if (idx < 0 || idx >= this.count) return null;
    const start = (this.head - this.count + this.capacity * 2) % this.capacity;
    return this.ring[(start + idx) % this.capacity] ?? null;
  }

  /** Mirror position at `hostNs`: linear interpolation between the bracketing
   *  samples; clamped (with `interpolated: false`) outside the span; null when
   *  the ring is empty. */
  mirrorAt(hostNs: bigint): MirrorAt | null {
    if (this.count === 0) return null;
    const oldest = this.at(0)!;
    const newest = this.at(-1)!;
    if (hostNs <= oldest.hostNs)
      return {
        left: oldest.left,
        right: oldest.right,
        ageNs: oldest.hostNs - hostNs,
        interpolated: hostNs === oldest.hostNs,
      };
    if (hostNs >= newest.hostNs)
      return {
        left: newest.left,
        right: newest.right,
        ageNs: hostNs - newest.hostNs,
        interpolated: hostNs === newest.hostNs,
      };
    // Binary search for the first sample with t > hostNs.
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.at(mid)!.hostNs <= hostNs) lo = mid + 1;
      else hi = mid;
    }
    const after = this.at(lo)!;
    const before = this.at(lo - 1)!;
    const span = after.hostNs - before.hostNs;
    const t = span === 0n ? 0 : Number(hostNs - before.hostNs) / Number(span);
    const ageNs =
      hostNs - before.hostNs < after.hostNs - hostNs
        ? hostNs - before.hostNs
        : after.hostNs - hostNs;
    return {
      left: lerpPos(before.left, after.left, t),
      right: lerpPos(before.right, after.right, t),
      ageNs,
      interpolated: true,
    };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

/** THE orchestrator-wide history (single controller ⇒ single trajectory).
 *  Written by the actuation loop; read by the fovea/undistort homography. */
export const mirrorHistory = new MirrorHistory();
