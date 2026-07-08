// Unit coverage for the Vue-free session-resource primitives (A-R2-P1, the
// non-breaking building blocks the A-P1 lifecycle refactor sits on):
// DisposerBag, releaseLeases. Types-only imports, so no native/mocking needed —
// fakes stand in for CameraLease. (C-22b step 3 retired `bindViews` — all vision
// now reads the `camera:<serial>` pipe in worker threads, not `onView`.)

import { describe, expect, it, vi } from "vitest";
import {
  DisposerBag,
  releaseLeases,
  type LeaseSet,
} from "@orchestrator/session-resources";
import type { CameraLease } from "@orchestrator/registry";

function fakeLease(): CameraLease & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(),
  } as unknown as CameraLease & { release: ReturnType<typeof vi.fn> };
}
const fakeSet = (): LeaseSet => ({ L: fakeLease(), C: fakeLease(), R: fakeLease() });

describe("DisposerBag", () => {
  it("disposes all added disposers, in order, then clears (idempotent)", () => {
    const bag = new DisposerBag();
    const order: string[] = [];
    const a = bag.add(() => order.push("a"));
    bag.add(() => order.push("b"));
    expect(a).toBeTypeOf("function"); // add returns the disposer
    bag.dispose();
    expect(order).toEqual(["a", "b"]);
    bag.dispose(); // already drained → no re-run
    expect(order).toEqual(["a", "b"]);
  });

  it("push adds multiple disposers at once", () => {
    const bag = new DisposerBag();
    const seen: number[] = [];
    bag.push(() => seen.push(1), () => seen.push(2), () => seen.push(3));
    bag.dispose();
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("releaseLeases", () => {
  it("is a no-op for null / undefined (never throws)", () => {
    expect(() => releaseLeases(null)).not.toThrow();
    expect(() => releaseLeases(undefined)).not.toThrow();
  });

  it("releases every lease of a plain LeaseSet", () => {
    const set = fakeSet();
    releaseLeases(set);
    for (const role of ["L", "C", "R"] as const)
      expect((set[role] as any).release).toHaveBeenCalledTimes(1);
  });

  it("releases through a CalibratedTriple's `.leases`", () => {
    const set = fakeSet();
    releaseLeases({ leases: set } as any);
    for (const role of ["L", "C", "R"] as const)
      expect((set[role] as any).release).toHaveBeenCalledTimes(1);
  });
});
