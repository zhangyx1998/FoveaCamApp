// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Hardware-acquisition gate: a fresh orchestrator instance builds its graph
// immediately but must not touch exclusive hardware until the previous instance is
// confirmed dead + swept (main's "hardware-clear" message). Every chokepoint
// (registry.acquire/acquireMany, controller.connect) awaits awaitHardwareClear() — ONE
// gate, not per-session. Disarmed by default (tests never block); arm()ed at boot,
// opened exactly once by signalHardwareClear(). Vue-free.
// spec: docs/spec/orchestrator-runtime.md#hardware-gate

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
