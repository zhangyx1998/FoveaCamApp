// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Homography feeder (unified-time-and-topology §3+§5): the ~200 Hz timer that
// pushes H(mirrorAt(now)) samples into an L/R HOMOGRAPHY undistort brick.
// Pure-tested with fake timers + injected history/clock/push — cadence,
// sample-time stamping (hostNs = the mirror sample's own record time),
// null-H = no push (honest passthrough), and stop-on-dispose.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversionComputeH,
  startHomographyFeeder,
  type ComputeH,
  type PushHomography,
} from "@orchestrator/homography-feeder";
import type { MirrorAt } from "@orchestrator/mirror-history";

const H9 = (v: number) => Float64Array.of(v, 0, 0, 0, v, 0, 0, 0, 1);

function harness(opts?: {
  computeH?: ComputeH;
  mirrorAt?: (ns: bigint) => MirrorAt | null;
}) {
  let nowNs = 1_000_000n;
  const pushes: { pipeId: string; hostNs: bigint; h: Float64Array }[] = [];
  const push: PushHomography = vi.fn((pipeId, hostNs, h) => {
    pushes.push({ pipeId, hostNs, h });
    return true;
  });
  const sample: MirrorAt = {
    left: { x: 0.1, y: 0.2 },
    right: { x: -0.1, y: -0.2 },
    ageNs: 250_000n, // newest sample is 0.25 ms old — hostNs = now - ageNs
    interpolated: false,
  };
  const stop = startHomographyFeeder({
    pipeId: "camera/SNL/undistort",
    side: "L",
    computeH: opts?.computeH ?? (() => H9(2)),
    push,
    intervalMs: 5,
    history: { mirrorAt: opts?.mirrorAt ?? (() => sample) },
    now: () => (nowNs += 5_000_000n), // +5 ms per tick, in step with the timer
  });
  return { stop, push, pushes };
}

describe("homography feeder (§5 L/R bricks)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pushes at the timer cadence with hostNs = the sample's record time", () => {
    const h = harness();
    expect(h.push).not.toHaveBeenCalled(); // no immediate tick
    vi.advanceTimersByTime(25); // 5 ticks at 5 ms
    expect(h.pushes).toHaveLength(5);
    const first = h.pushes[0]!;
    expect(first.pipeId).toBe("camera/SNL/undistort");
    // now() returned 6_000_000n on tick 1; ageNs 250_000n → the sample time.
    expect(first.hostNs).toBe(6_000_000n - 250_000n);
    expect(Array.from(first.h)).toEqual(Array.from(H9(2)));
    h.stop();
  });

  it("computeH returning null = NO push (brick passes through, honest)", () => {
    const h = harness({ computeH: () => null });
    vi.advanceTimersByTime(50);
    expect(h.push).not.toHaveBeenCalled();
    h.stop();
  });

  it("empty mirror history = NO push", () => {
    const h = harness({ mirrorAt: () => null });
    vi.advanceTimersByTime(50);
    expect(h.push).not.toHaveBeenCalled();
    h.stop();
  });

  it("stop() halts the feed (idempotent)", () => {
    const h = harness();
    vi.advanceTimersByTime(10);
    expect(h.pushes).toHaveLength(2);
    h.stop();
    h.stop(); // second call is a no-op
    vi.advanceTimersByTime(50);
    expect(h.pushes).toHaveLength(2);
  });

  it("conversionComputeH derives per side via A2H(V2A(volts))", () => {
    const calls: string[] = [];
    const conv = {
      V2A: {
        L: (v: { x: number; y: number }) => (calls.push(`V2A.L(${v.x})`), { x: v.x * 2, y: v.y * 2 }),
        R: (v: { x: number; y: number }) => (calls.push(`V2A.R(${v.x})`), { x: v.x * 3, y: v.y * 3 }),
      },
      A2H: {
        L: (a: { x: number; y: number }) => (calls.push(`A2H.L(${a.x})`), H9(a.x)),
        R: (a: { x: number; y: number }) => (calls.push(`A2H.R(${a.x})`), H9(a.x)),
      },
    } as never;
    const computeH = conversionComputeH(conv);
    const mirror = { left: { x: 1, y: 0 }, right: { x: 5, y: 0 } };
    const hl = computeH(mirror, "L")!;
    expect(calls).toEqual(["V2A.L(1)", "A2H.L(2)"]); // left volts, chained
    expect(hl[0]).toBe(2);
    calls.length = 0;
    const hr = computeH(mirror, "R")!;
    expect(calls).toEqual(["V2A.R(5)", "A2H.R(15)"]); // right volts, chained
    expect(hr[0]).toBe(15);
  });
});
