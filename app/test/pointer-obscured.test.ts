// Pointer-obscuration tracker (value-sweep addendum 2026-07-11) — the pure
// decision logic behind FrameView/PosView's drag/hover gating
// (@lib/pointer-obscured): containment vs covered vs outside-the-box, and the
// rounded-coordinate memo that keeps `elementFromPoint` off the 1 kHz
// pointerrawupdate hot path. DOM-free: the container + hit lookup are
// structural fakes.

import { describe, expect, it } from "vitest";
import {
  createObscurationTracker,
  type ContainerLike,
} from "@lib/pointer-obscured";

function fakeContainer(over: {
  rect?: { left: number; top: number; right: number; bottom: number };
  children?: unknown[];
  connected?: boolean;
}): ContainerLike {
  const children = over.children ?? [];
  return {
    isConnected: over.connected ?? true,
    getBoundingClientRect: () =>
      over.rect ?? { left: 0, top: 0, right: 100, bottom: 100 },
    contains: (el) => el === self || children.includes(el),
  };
  // `contains(container)` must hold like DOM's Node.contains(self) — the
  // tracker also accepts top === container directly, so this shorthand works.
}
const self = Symbol("self-marker"); // unused sentinel to keep contains simple

describe("obscuration decision", () => {
  it("is NOT obscured when the topmost element is the container or a descendant", () => {
    const child = { tag: "canvas" };
    const container = fakeContainer({ children: [child] });
    const obscured = createObscurationTracker(() => child);
    expect(obscured(container, { clientX: 50, clientY: 50 })).toBe(false);
    const direct = createObscurationTracker(() => container);
    expect(direct(container, { clientX: 50, clientY: 50 })).toBe(false);
  });

  it("IS obscured when a foreign element is topmost inside the container box", () => {
    const drawer = { tag: "drawer" };
    const container = fakeContainer({ children: [{ tag: "canvas" }] });
    const obscured = createObscurationTracker(() => drawer);
    expect(obscured(container, { clientX: 50, clientY: 50 })).toBe(true);
  });

  it("is NOT obscured outside the container's box (off-edge drags keep steering)", () => {
    const drawer = { tag: "drawer" };
    let lookups = 0;
    const container = fakeContainer({});
    const obscured = createObscurationTracker(() => (lookups++, drawer));
    expect(obscured(container, { clientX: 150, clientY: 50 })).toBe(false);
    expect(obscured(container, { clientX: 50, clientY: -1 })).toBe(false);
    expect(lookups).toBe(0); // outside short-circuits BEFORE the hit-test
  });

  it("treats a null/disconnected container and a null hit as safe defaults", () => {
    const obscuredNull = createObscurationTracker(() => null);
    const container = fakeContainer({});
    // Topmost unknown (null hit) → conservatively obscured inside the box.
    expect(obscuredNull(container, { clientX: 10, clientY: 10 })).toBe(true);
    expect(obscuredNull(null, { clientX: 10, clientY: 10 })).toBe(false);
    const gone = fakeContainer({ connected: false });
    expect(obscuredNull(gone, { clientX: 10, clientY: 10 })).toBe(false);
  });

  it("memoizes the hit-test on rounded coordinates (1 kHz rawupdate discipline)", () => {
    const child = { tag: "canvas" };
    const container = fakeContainer({ children: [child] });
    let lookups = 0;
    const obscured = createObscurationTracker(() => (lookups++, child));
    // Sub-pixel jitter around the same screen pixel: ONE lookup.
    obscured(container, { clientX: 50.1, clientY: 50.2 });
    obscured(container, { clientX: 50.3, clientY: 49.9 });
    obscured(container, { clientX: 49.8, clientY: 50.4 });
    expect(lookups).toBe(1);
    // A real 1 px move re-tests.
    obscured(container, { clientX: 51.6, clientY: 50 });
    expect(lookups).toBe(2);
  });

  it("re-evaluates containment per container even on a memo hit", () => {
    const child = { tag: "canvas" };
    const a = fakeContainer({ children: [child] });
    const b = fakeContainer({ children: [] }); // same spot, does NOT own child
    const tracker = createObscurationTracker(() => child);
    expect(tracker(a, { clientX: 20, clientY: 20 })).toBe(false);
    // Same coords (memo hit, no second lookup) — different container must
    // still get ITS OWN containment verdict.
    expect(tracker(b, { clientX: 20, clientY: 20 })).toBe(true);
  });
});
