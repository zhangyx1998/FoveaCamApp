// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Hardware-acquisition GATE (disposable-orchestrator ruling 2). A fresh
// orchestrator instance forks and builds its node graph IMMEDIATELY, but must
// not touch the exclusive hardware (Aravis cameras, MEMS serial) until the
// PREVIOUS hardware instance is confirmed dead + swept — main signals this with
// a "hardware-clear" message. Aravis is per-process exclusive, so acquisition
// serializes even while spin-up overlaps the old instance's teardown.
//
// Every hardware chokepoint (`registry.acquire`/`acquireMany`,
// `controller.connect`) awaits `awaitHardwareClear()` before opening a device,
// so the deferral is ONE gate, not scattered per-session. While something
// waits, the gate reports a "waiting" state so the orchestrator surfaces a
// named progress step (the user sees WHY spin-up pauses). Vue-free.
//
// The gate is DISARMED by default so unit tests that exercise acquire/connect
// never block; the orchestrator process `arm()`s it at boot (closed until
// main's message), then `signalHardwareClear()` opens it exactly once.

let armed = false;
let cleared = false;
let resolveClear: (() => void) | null = null;
let clearPromise: Promise<void> = Promise.resolve();

let waiters = 0;
const waitListeners = new Set<(waiting: boolean) => void>();

function notifyWaiting(): void {
  const waiting = isWaitingForHardware();
  for (const fn of waitListeners) fn(waiting);
}

/** Close the gate at orchestrator boot: acquisition now BLOCKS until main sends
 *  "hardware-clear". Called once by the orchestrator entry, before any session
 *  can activate. No-op if already armed. */
export function armHardwareGate(): void {
  if (armed) return;
  armed = true;
  cleared = false;
  clearPromise = new Promise<void>((resolve) => {
    resolveClear = resolve;
  });
}

/** Main → orchestrator "hardware-clear": open the gate (idempotent). */
export function signalHardwareClear(): void {
  if (cleared) return;
  cleared = true;
  resolveClear?.();
  notifyWaiting();
}

/** True once acquisition is allowed (never armed, or main granted the clear). */
export function hardwareCleared(): boolean {
  return !armed || cleared;
}

/** Await the hardware-clear grant. Every device-opening path calls this before
 *  touching a camera / the MEMS serial. Resolves immediately while disarmed or
 *  already cleared. */
export async function awaitHardwareClear(): Promise<void> {
  if (hardwareCleared()) return;
  waiters++;
  notifyWaiting();
  try {
    await clearPromise;
  } finally {
    waiters--;
    notifyWaiting();
  }
}

/** Is at least one acquisition currently blocked on the gate? Drives the
 *  "waiting for previous session to release hardware" progress step. */
export function isWaitingForHardware(): boolean {
  return armed && !cleared && waiters > 0;
}

/** Observe the waiting state (progress-overlay driver). Returns a disposer. */
export function onHardwareWaitChange(fn: (waiting: boolean) => void): () => void {
  waitListeners.add(fn);
  return () => waitListeners.delete(fn);
}
