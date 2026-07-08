// Unit coverage for the Vue-free session-resource primitives (A-R2-P1, the
// non-breaking building blocks the future A-P1 lifecycle refactor sits on):
// DisposerBag, releaseLeases, bindViews. Types-only imports, so no native/
// mocking needed — fakes stand in for CameraLease / ServerSession.

import { describe, expect, it, vi } from "vitest";
import {
  DisposerBag,
  bindViews,
  releaseLeases,
  type LeaseSet,
} from "@orchestrator/session-resources";
import type { CameraLease } from "@orchestrator/registry";
import type { ServerSession } from "@orchestrator/runtime";

function fakeLease(): CameraLease & { release: ReturnType<typeof vi.fn> } {
  return {
    release: vi.fn(),
    // onView registers a tap and returns its unsubscriber.
    onView: vi.fn((_cb: (raw: any) => void) => vi.fn()),
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

describe("bindViews", () => {
  const fakeSession = () =>
    ({ frame: vi.fn() }) as unknown as ServerSession<any> & {
      frame: ReturnType<typeof vi.fn>;
    };

  it("taps L/C/R views and, by default, republishes each as a session frame", () => {
    const set = fakeSet();
    const session = fakeSession();
    const bag = new DisposerBag();
    bindViews(set, bag, session);
    for (const role of ["L", "C", "R"] as const)
      expect((set[role] as any).onView).toHaveBeenCalledTimes(1);
    // Drive one tap → default handler forwards to session.frame(role, raw).
    const rawL = { shape: [2, 2], channels: 1 } as any;
    (set.L as any).onView.mock.calls[0][0](rawL);
    expect((session as any).frame).toHaveBeenCalledWith("L", rawL);
  });

  it("uses a custom onView when provided (no default frame publish)", () => {
    const set = fakeSet();
    const session = fakeSession();
    const bag = new DisposerBag();
    const seen: Array<[string, any]> = [];
    bindViews(set, bag, session, (role, raw) => seen.push([role, raw]));
    const rawR = { shape: [1, 1], channels: 1 } as any;
    (set.R as any).onView.mock.calls[0][0](rawR);
    expect(seen).toEqual([["R", rawR]]);
    expect((session as any).frame).not.toHaveBeenCalled();
  });

  it("adds each tap's unsubscriber to the bag so dispose() detaches them", () => {
    const set = fakeSet();
    const unsubs = ["L", "C", "R"].map(() => vi.fn());
    let i = 0;
    for (const role of ["L", "C", "R"] as const)
      (set[role] as any).onView = vi.fn(() => unsubs[i++]);
    const bag = new DisposerBag();
    bindViews(set, bag, fakeSession());
    bag.dispose();
    for (const u of unsubs) expect(u).toHaveBeenCalledTimes(1);
  });
});
