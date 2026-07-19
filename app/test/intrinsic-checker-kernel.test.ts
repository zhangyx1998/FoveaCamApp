// The checker kernel must gate on corners.length === W*H, not on any non-empty
// corner list: `findChessboardCorners`' contract (the discarded found-boolean)
// is "all W×H corners located, in order", so a partial detection must NOT be
// capturable.

import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  corners: [] as { x: number; y: number }[],
}));

vi.mock("core/Vision", () => ({
  cvtColor: (raw: unknown) => raw, // identity — the gate under test is the count
  findChessboardCorners: async () => state.corners,
}));

import { createCheckerKernel, type CheckerValues } from "@modules/calibrate-intrinsic/vision";
import { makeMat } from "@lib/mat";

const frame = () => ({
  C: { mat: makeMat(new Uint8Array(4 * 3 * 4), [3, 4], 4), meta: {} },
});

const corners = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ x: i, y: i }));

describe("checker kernel full-board gate", () => {
  it("a COMPLETE W*H detection posts points + the gray frame", async () => {
    const kernel = createCheckerKernel({ patternWidth: 3, patternHeight: 2 });
    state.corners = corners(6); // 3×2 = complete
    const out = (await kernel.process(frame() as never))!;
    const v = out.values as CheckerValues;
    expect(v.points).toHaveLength(6);
    expect(out.frames).toHaveLength(1);
    expect(out.frames[0]!.name).toBe("gray");
  });

  it("a PARTIAL detection (corners < W*H) reads as NO detection", async () => {
    const kernel = createCheckerKernel({ patternWidth: 3, patternHeight: 2 });
    state.corners = corners(4); // partial board
    const out = (await kernel.process(frame() as never))!;
    const v = out.values as CheckerValues;
    expect(v.points).toBeNull(); // not capturable
    expect(out.frames).toHaveLength(0);
  });

  it("an OVER-COUNT (stale param race) also reads as no detection", async () => {
    const kernel = createCheckerKernel({ patternWidth: 3, patternHeight: 2 });
    state.corners = corners(9);
    const out = (await kernel.process(frame() as never))!;
    expect((out.values as CheckerValues).points).toBeNull();
  });

  it("zero corners keeps the existing null contract", async () => {
    const kernel = createCheckerKernel({ patternWidth: 3, patternHeight: 2 });
    state.corners = [];
    const out = (await kernel.process(frame() as never))!;
    expect((out.values as CheckerValues).points).toBeNull();
  });
});
