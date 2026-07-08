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
// docs/history/refactor/orchestrator.md §12.1 C9), and idle-wait rather than spin at
// the actuation interval when no controller is attached. Volt-telemetry
// throttling is intentionally left to the caller (`onVolts` fires on every
// successful actuate, unthrottled) — it's UI-specific and each session
// already tracks its own local volts mirror for reasons beyond telemetry
// (e.g. fovea wrap homography), so imposing one throttle policy here would
// fight a caller that needs the immediate value too.

import { activeController, type Controller, type StreamHandle } from "./controller.js";
import type { Pos } from "@lib/controller-codec";

export interface ActuationLoopOptions {
  /** Target volts for this tick — always called, even before calibration is
   *  ready (return `{x:0,y:0}` origin in that case, matching every current
   *  caller's fallback). */
  targetVolts(): { l: Pos; r: Pos };
  /** Actuated volts, called on every successful tick (unthrottled).
   *  `actuateMs` is this tick's `c.actuate()` round-trip (perf substrate,
   *  docs/history/refactor/orchestrator.md §7.3 item 2) — under the single-phase
   *  controller semantics this is the whole wire-RTT-plus-completion time.
   *  On the A-30 fire-and-forget streaming path (v2 firmware) there is no
   *  round-trip, so `actuateMs` is ~0 (the `controller:<port>` A-29 packets/sec
   *  meter is the RTT stat's replacement) and `volt` is the LOCAL prediction
   *  (`c.predictVolts` — the same math the ACK readback would echo), not an
   *  awaited readback. */
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

  // A-30 streaming state. When the attached controller is v2-capable the hot
  // path is a fire-and-forget CMD_STREAM `update()` (no awaited round-trip);
  // `stream` is the open handle and `streamOwner` the Controller it belongs to,
  // so a reconnect (a fresh Controller instance) drops the stale handle and
  // reopens. Held null on v1 firmware, where we keep the awaited `actuate()`.
  let stream: StreamHandle | null = null;
  let streamOwner: Controller | null = null;

  async function closeStream(): Promise<void> {
    const s = stream;
    stream = null;
    streamOwner = null;
    if (s) {
      try {
        await s.close();
      } catch {
        // Best-effort TERMINATE — a dropped controller may already be gone.
      }
    }
  }

  void (async () => {
    while (running) {
      const c = activeController();
      if (!c) {
        // No controller: drop any stale stream and idle-wait. A reconnect gets
        // a fresh Controller instance (reopened lazily below).
        await closeStream();
        enabledByUs = false;
        await new Promise((r) => setTimeout(r, idleIntervalMs));
        continue;
      }
      // Controller swapped under us (reconnect) — the old handle is dead.
      if (streamOwner && streamOwner !== c) await closeStream();
      try {
        if (!c.enabled) {
          await c.enable();
          enabledByUs = true;
        }
        const { l, r } = opts.targetVolts();
        if (c.v2Capable) {
          // Fire-and-forget streaming hot path. FW5: this loop owns the stream
          // exclusively while running — no concurrent awaited Actuate.
          if (!stream) {
            // CREATE positions at the initial target; this tick doesn't also
            // update() (it's already there).
            stream = await c.createStream({ left: l, right: r });
            streamOwner = c;
          } else {
            stream.update({ left: l, right: r });
          }
          // Local prediction stands in for the readback the stream protocol has
          // no response for; ~0 RTT (the A-29 packets/sec meter is the rate).
          const p = c.predictVolts({ left: l, right: r });
          opts.onVolts({ L: p.left, R: p.right }, 0);
        } else {
          // v1 firmware: no CMD_STREAM — keep the awaited actuate() round-trip.
          const t0 = performance.now();
          const { left, right } = await c.actuate({ left: l, right: r });
          opts.onVolts({ L: left, R: right }, performance.now() - t0);
        }
      } catch {
        // Controller dropped / not enabled / stream broke — drop the handle so
        // the next good tick reopens, and retry.
        await closeStream();
        enabledByUs = false;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    // Teardown: close the stream, then disable iff this loop enabled it.
    await closeStream();
    if (enabledByUs) {
      activeController()?.disable();
      enabledByUs = false;
    }
  })();

  return {
    stop() {
      running = false;
    },
  };
}
