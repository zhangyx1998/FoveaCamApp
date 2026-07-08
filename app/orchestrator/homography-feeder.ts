// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Homography feeder (docs/proposals/unified-time-and-topology.md §3+§5): while
// a triple session is active, each L/R HOMOGRAPHY undistort brick needs a
// steady stream of `{hostNs, H}` samples in its native ParamRing so the
// undistort thread can warp every frame with `H(mirrorAt(frameHostNs))`. This
// helper runs a modest fixed-rate timer (~200 Hz — well under the ring's
// ~1 kHz design ceiling, dense enough that the ring's linear interpolation
// between neighbors tracks the ~1 kHz actuation trajectory) that:
//
//   1. reads the NEWEST mirror sample from the orchestrator-wide
//      `mirrorHistory` (written by the actuation loop),
//   2. derives H for its side via the injected `computeH` seam,
//   3. pushes it via `Aravis.pushHomography(pipeId, hostNs, h9)` with
//      hostNs = the SAMPLE's time (not push time) — the brick matches frames
//      against when the mirror was actually there.
//
// `computeH` returning null = no push (empty history, uncalibrated rig, or a
// deliberately-unwired v1 seam) — the brick meters `passthrough`, honest.
// Everything is injected (history/clock/push) so vitest drives the cadence
// with fake timers and never loads native core.

import { mirrorHistory, type MirrorAt } from "./mirror-history.js";
import { hostNowNs } from "./time-align.js";
import type { CoordinateConversions } from "@lib/coordinate-conversions";
import type { Pos } from "@lib/controller-codec";

/** The v1 H-derivation seam: mirror position (both eyes) → the 3×3 row-major
 *  homography (9 doubles) for one side, or null when H cannot be derived
 *  (no calibration / not yet wired) — null is NOT pushed. */
export type ComputeH = (
  mirror: { left: Pos; right: Pos },
  side: "L" | "R",
) => Float64Array | null;

/** `Aravis.pushHomography`'s shape (injected — sessions pass the native fn). */
export type PushHomography = (
  pipeId: string,
  hostNs: bigint,
  h: Float64Array,
) => boolean;

export interface HomographyFeederOptions {
  /** The homography undistort brick's pipe id (`camera/<serial>/undistort`). */
  pipeId: string;
  side: "L" | "R";
  computeH: ComputeH;
  push: PushHomography;
  /** Feed period. Default 5 ms (~200 Hz). */
  intervalMs?: number;
  /** Injectable for tests; defaults to THE orchestrator-wide `mirrorHistory`. */
  history?: Pick<typeof mirrorHistory, "mirrorAt">;
  /** Injectable for tests; defaults to `hostNowNs`. */
  now?: () => bigint;
}

/** Start feeding H samples into a homography undistort brick. Returns the
 *  stop disposer (idempotent) — call it BEFORE detaching the brick. */
export function startHomographyFeeder(opts: HomographyFeederOptions): () => void {
  const {
    pipeId,
    side,
    computeH,
    push,
    intervalMs = 5,
    history = mirrorHistory,
    now = hostNowNs,
  } = opts;
  const tick = (): void => {
    const t = now();
    const m: MirrorAt | null = history.mirrorAt(t);
    if (!m) return; // no mirror samples yet — brick passes through
    const h = computeH({ left: m.left, right: m.right }, side);
    if (!h) return; // seam unwired / underivable — no push (honest)
    // `mirrorAt(now)` clamps to the NEWEST sample (queries at now are past the
    // ring's end), so `t - ageNs` is that sample's own record time — the
    // instant the mirror command was actually issued.
    push(pipeId, t - m.ageNs, h);
  };
  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for a feeder (sessions stop it on drain; this
  // is belt-and-braces for shutdown paths).
  timer.unref?.();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * The v1 default `computeH`, wired from the triple's calibrated conversions:
 * `A2H[side](V2A[side](volts))` — the exact volt→angle→homography chain the
 * display path already uses per fovea (`display-transport.ts`: "9-element
 * homography A2H[role](V2A[role](volts))", consumed by `wrapPerspective` on
 * that side's frame). `Mat<Float64Array>` IS a Float64Array (shape props
 * tacked on — see @lib/mat), so it feeds `pushHomography` directly.
 *
 * OPEN QUESTION (report + Stage-F rig check): `A2H` was fit by
 * `findPinholeProjection` to map fovea IMAGE points onto the flattened
 * marker-plane projection — the same matrix the display wrap applies, but
 * whether the native brick wants exactly this H or its inverse/composition
 * into wide-frame coordinates is only verifiable on the rig. The seam is
 * injected precisely so this can be swapped without touching the feeder.
 */
export function conversionComputeH(
  conv: Pick<CoordinateConversions, "A2H" | "V2A">,
): ComputeH {
  return (mirror, side) => {
    const volt = side === "L" ? mirror.left : mirror.right;
    const H =
      side === "L"
        ? conv.A2H.L(conv.V2A.L(volt))
        : conv.A2H.R(conv.V2A.R(volt));
    return H as unknown as Float64Array;
  };
}
