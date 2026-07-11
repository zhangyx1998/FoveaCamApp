// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PID limit re-bounding (value-sweep 2026-07-11 `verge-integral-clamp-stale`):
// the constructor aliases `integralLimits` to the `limits` ARRAY when no
// explicit integral clamp is given — a later bare `.limits = [...]` left the
// integrator (the COMMAND, in velocity form) clamped to the construction-time
// bound. `setLimits` updates both and re-clamps the live integrator.

import { describe, expect, it } from "vitest";
import { PID } from "@lib/pid";

/** The disparity verge shape: velocity-form (kp = kd = 0, integrator = the
 *  command), constructed against the DEFAULT 200 mm baseline bound. */
const VERGE_AT_200MM = 0.5; // stand-in for distanceToVerge(150, 200)
const VERGE_AT_400MM = 1.0; // a 400 mm rig resolves a WIDER verge range

describe("PID.setLimits (verge-integral-clamp-stale)", () => {
  it("REGRESSION: a bare `.limits =` leaves the integrator clamped to the construction bound", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_200MM] });
    pid.limits = [0, VERGE_AT_400MM]; // the OLD two-site pattern
    for (let i = 0; i < 100; i++) pid.step(1, 1); // drive toward the new bound
    // The command saturates at the STALE construction-time bound — the defect.
    expect(pid.value).toBe(VERGE_AT_200MM);
  });

  it("setLimits widens BOTH bounds — the 400 mm-baseline rig gets its full range", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_200MM] });
    pid.setLimits([0, VERGE_AT_400MM]);
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(VERGE_AT_400MM); // integrates to the NEW bound
    expect(pid.limits).toEqual([0, VERGE_AT_400MM]);
    expect(pid.integralLimits).toEqual([0, VERGE_AT_400MM]);
  });

  it("setLimits narrows: the live command re-clamps immediately (no stale out-of-range value)", () => {
    const pid = new PID({ ki: 1, limits: [0, VERGE_AT_400MM] });
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(VERGE_AT_400MM);
    pid.setLimits([0, VERGE_AT_200MM]);
    expect(pid.value).toBe(VERGE_AT_200MM);
  });

  it("an explicit integralLimits stays independent of the output bound", () => {
    const pid = new PID({ ki: 1, limits: [0, 10] });
    pid.setLimits([0, 10], [0, 2]); // anti-windup tighter than output
    for (let i = 0; i < 100; i++) pid.step(1, 1);
    expect(pid.value).toBe(2);
  });
});
