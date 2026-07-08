// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Vue-free session resource helpers. These are intentionally small primitives,
// not a lifecycle framework: sessions keep their own idle ordering and only
// share the repetitive disposer / camera-lease loops.

import type { Role } from "@lib/camera-config";
import type { CalibratedTriple } from "./calibration.js";
import type { CameraLease } from "./registry.js";
import type { ServerSession } from "./runtime.js";
import type { Contract } from "@lib/orchestrator/protocol";

export type Disposer = () => void;

export class DisposerBag {
  private readonly disposers: Disposer[] = [];

  add(disposer: Disposer): Disposer {
    this.disposers.push(disposer);
    return disposer;
  }

  push(...disposers: Disposer[]): number {
    return this.disposers.push(...disposers);
  }

  dispose(): void {
    const disposers = this.disposers.splice(0);
    for (const dispose of disposers) dispose();
  }
}

export type LeaseSet = Record<Role, CameraLease>;

export function releaseLeases(target: CalibratedTriple | LeaseSet | null | undefined): void {
  if (!target) return;
  const leases = "leases" in target ? target.leases : target;
  for (const lease of Object.values(leases)) lease.release();
}

/** Publish the leased triple's camera serials into `state.serials` (C-22) so the
 *  renderer can bind raw previews to the native `camera:<serial>` pipe via
 *  `usePipeFrame` — replacing the JS `onView` view-tap for the raw feeds. Every
 *  triple contract declares `serials: {} as Partial<Record<"L"|"C"|"R", string>>`.
 *  Cleared to `{}` on release (a disposer). */
export function publishSerials<C extends Contract>(
  leases: LeaseSet,
  // Any disposer collector — `DisposerBag` OR a `ResourceScope` (both expose
  // `.add`), so triple sessions can pass whichever they already hold.
  disposers: { add(disposer: () => void): void },
  session: ServerSession<C>,
): void {
  // Keep the call ON the session — `setState` is a class method that reads
  // `this.state`; detaching it (`const set = session.setState`) loses `this`
  // and throws "Cannot read properties of undefined (reading 'state')" at
  // activation (rig-found; invisible to vue-tsc through the type cast).
  const set = (key: string, value: unknown): void =>
    (session as { setState(key: string, value: unknown): void }).setState(key, value);
  set("serials", {
    L: leases.L.camera.serial,
    C: leases.C.camera.serial,
    R: leases.R.camera.serial,
  });
  disposers.add(() => set("serials", {}));
}
