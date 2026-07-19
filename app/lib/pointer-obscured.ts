/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

// Pointer OBSCURATION test: drag/hover surfaces that install
// window-level listeners (FrameView steer, PosView voltage drag) keep
// processing every pointer event even when another element — the drawer, a
// dialog — sits ON TOP of them, so "drags through the drawer" kept steering
// the mirrors. `obscured(container, event)` answers: is the pointer INSIDE
// the container's box but the topmost element at that point NOT part of the
// container?
//
//  - Inside the box + topmost element within container → false (normal hit).
//  - Inside the box + topmost element elsewhere        → true  (covered —
//    suppress the emit; a drag stays alive and resumes on re-emerge).
//  - OUTSIDE the container's box                       → false — nothing is
//    "covering" the surface there. Deliberate: dragging past the edge of a
//    FrameView/PosView is a designed steer gesture (positions clamp), and it
//    must keep working.
//
// Cost discipline: `document.elementFromPoint` + `getBoundingClientRect` are
// layout hit-tests that may run per pointerrawupdate event (up to ~1 kHz) —
// both are memoized on the ROUNDED pointer coordinates, so a burst of
// sub-pixel raw updates costs one lookup per screen pixel actually crossed.
// (The one blind spot of that memo — DOM changing under a MOTIONLESS pointer
// mid-drag — self-heals on the next 1 px move.)
//
// Renderer-only (document.*), Vue-free — the `element-size.ts` precedent.
// Never import from orchestrator-reachable code. The DOM surface is typed
// structurally so the decision logic unit-tests without a DOM
// (app/test/pointer-obscured.test.ts).

/** The slice of Element the tracker touches (structural, for tests). */
export interface ContainerLike {
  isConnected: boolean;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number };
  contains(other: unknown | null): boolean;
}

export interface PointerLike {
  clientX: number;
  clientY: number;
}

export type HitLookup = (x: number, y: number) => unknown | null;

/** Build an obscuration tracker with an injectable hit-test (tests stub it;
 *  components use the shared `pointerObscured` below). Each tracker memoizes
 *  the LAST looked-up point — one pointer, one hot path. */
export function createObscurationTracker(
  lookup: HitLookup = (x, y) => document.elementFromPoint(x, y),
) {
  let memoX = NaN;
  let memoY = NaN;
  let top: unknown | null = null;
  return function obscured(
    container: ContainerLike | null | undefined,
    e: PointerLike,
  ): boolean {
    if (!container || !container.isConnected) return false;
    const rect = container.getBoundingClientRect();
    // Outside the container's own box: not obscured by construction (see
    // header — off-edge drags must keep steering).
    if (
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top || e.clientY > rect.bottom
    )
      return false;
    const x = Math.round(e.clientX);
    const y = Math.round(e.clientY);
    if (x !== memoX || y !== memoY) {
      memoX = x;
      memoY = y;
      top = lookup(x, y);
    }
    return !(top !== null && (top === container || container.contains(top)));
  };
}

/** The shared renderer-wide tracker (one pointer → one memo). */
export const pointerObscured = createObscurationTracker();
