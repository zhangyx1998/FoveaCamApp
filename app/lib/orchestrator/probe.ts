// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera-enumeration PROBE contract + pure helpers (disposable-orchestrator
// ruling 3). The probe is a small persistent enumerate-only process
// (orchestrator/probe.ts) that loads `core`, lists devices on an interval, and
// NEVER opens a camera. It outlives app instances and feeds the status-only
// Welcome window a live camera list + connected state.
//
// This module is renderer-SAFE and Vue-FREE: the probe process, main, and the
// Welcome renderer all share these types + the pure list-diff / status
// derivation so there is one source of truth and they can be unit-tested
// without Electron or a camera (test/probe-camera.test.ts).

/** One enumerated device, plain data. `role` is filled from saved config when
 *  the probe can read it cheaply (store-hub read); omitted otherwise. */
export type ProbeCamera = {
  vendor: string;
  model: string;
  serial: string;
  role?: string;
};

/** What the probe posts to main (and main forwards to Welcome). */
export type ProbeSnapshot = {
  cameras: ProbeCamera[];
};

/** Stable identity key for a probed camera (serial is the device identity). */
const keyOf = (c: ProbeCamera): string => c.serial;

/** Whether two camera lists differ in identity OR displayed fields — main only
 *  forwards a fresh snapshot to Welcome when this is true, so a 2s enumerate
 *  tick that found nothing new is silent (no needless renderer churn). Order-
 *  independent (enumeration order isn't stable across ticks). */
export function cameraListChanged(a: ProbeCamera[], b: ProbeCamera[]): boolean {
  if (a.length !== b.length) return true;
  const index = new Map(a.map((c) => [keyOf(c), c]));
  for (const c of b) {
    const prev = index.get(keyOf(c));
    if (!prev) return true; // a serial in b that a never had (lengths equal ⇒ also a removal)
    if (prev.vendor !== c.vendor || prev.model !== c.model || prev.role !== c.role)
      return true;
  }
  return false;
}

/** The Welcome window's connection status line (ruling 3). "orchestrator down"
 *  is GONE — Welcome no longer depends on an orchestrator; the status reflects
 *  the probe. `probing` is false until the first snapshot arrives. */
export function welcomeStatus(cameras: ProbeCamera[], probing: boolean): string {
  if (!probing) return "looking for cameras…";
  const n = cameras.length;
  if (n === 0) return "no cameras";
  return `connected — ${n} camera${n > 1 ? "s" : ""}`;
}

/** Sort probed cameras for a stable Welcome list: by role (L, C, R first, in
 *  that order), then serial — so the list doesn't reshuffle every tick. */
export function sortedCameras(cameras: ProbeCamera[]): ProbeCamera[] {
  const roleRank: Record<string, number> = { L: 0, C: 1, R: 2 };
  return [...cameras].sort((a, b) => {
    const ra = a.role !== undefined ? (roleRank[a.role] ?? 3) : 4;
    const rb = b.role !== undefined ? (roleRank[b.role] ?? 3) : 4;
    if (ra !== rb) return ra - rb;
    return a.serial < b.serial ? -1 : a.serial > b.serial ? 1 : 0;
  });
}
