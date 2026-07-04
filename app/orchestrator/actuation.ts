// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared timer-paced actuation loop, extracted from `tracking-single`'s
// original inline loop so `manual-control` doesn't duplicate the same subtle
// controller-lifecycle bookkeeping: only take enable/disable responsibility
// if *this* loop turned the controller on (so stopping it doesn't disable a
// controller the user enabled manually via the title bar — see
// docs/refactor/orchestrator.md §12.1 C9), and idle-wait rather than spin at
// the actuation interval when no controller is attached. Volt-telemetry
// throttling is intentionally left to the caller (`onVolts` fires on every
// successful actuate, unthrottled) — it's UI-specific and each session
// already tracks its own local volts mirror for reasons beyond telemetry
// (e.g. fovea wrap homography), so imposing one throttle policy here would
// fight a caller that needs the immediate value too.

import { activeController } from "./controller.js";
import type { Pos } from "@lib/controller-codec";

export interface ActuationLoopOptions {
  /** Target volts for this tick — always called, even before calibration is
   *  ready (return `{x:0,y:0}` origin in that case, matching every current
   *  caller's fallback). */
  targetVolts(): { l: Pos; r: Pos };
  /** Actuated volts, called on every successful tick (unthrottled).
   *  `actuateMs` is this tick's `c.actuate()` round-trip (perf substrate,
   *  docs/refactor/orchestrator.md §7.3 item 2) — under today's single-phase
   *  controller semantics this is the whole wire-RTT-plus-completion time;
   *  once the two-phase protocol (P3.1a) lands, callers may want to split
   *  wire-accept vs. completion, but that API doesn't exist yet. */
  onVolts(volt: { L: Pos; R: Pos }, actuateMs: number): void;
  /** Actuation tick interval in ms. */
  intervalMs?: number;
  /** Poll interval while no controller is attached, in ms. */
  idleIntervalMs?: number;
}

export interface ActuationLoop {
  /** Stop the loop; disables the controller iff this loop was the one that
   *  enabled it. */
  stop(): void;
}

export function startActuationLoop(opts: ActuationLoopOptions): ActuationLoop {
  const intervalMs = opts.intervalMs ?? 1;
  const idleIntervalMs = opts.idleIntervalMs ?? 250;
  let running = true;
  let enabledByUs = false;

  void (async () => {
    while (running) {
      const c = activeController();
      if (!c) {
        enabledByUs = false; // a reconnect gets a fresh Controller instance
        await new Promise((r) => setTimeout(r, idleIntervalMs));
        continue;
      }
      try {
        if (!c.enabled) {
          await c.enable();
          enabledByUs = true;
        }
        const { l, r } = opts.targetVolts();
        const t0 = performance.now();
        const { left, right } = await c.actuate({ left: l, right: r });
        opts.onVolts({ L: left, R: right }, performance.now() - t0);
      } catch {
        // Controller dropped / not enabled — retry on the next tick.
        enabledByUs = false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  return {
    stop() {
      running = false;
      if (enabledByUs) {
        activeController()?.disable();
        enabledByUs = false;
      }
    },
  };
}
