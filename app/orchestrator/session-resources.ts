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
import type { Mat } from "core/Vision";
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

export function bindViews<C extends Contract>(
  leases: LeaseSet,
  disposers: DisposerBag,
  session: ServerSession<C>,
  onView: (role: Role, raw: Mat<Uint8Array>) => void = (role, raw) => {
    session.frame(role, raw);
  },
): void {
  disposers.add(leases.L.onView((v) => onView("L", v)));
  disposers.add(leases.C.onView((v) => onView("C", v)));
  disposers.add(leases.R.onView((v) => onView("R", v)));
}
