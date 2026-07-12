// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE decisions for the disparity-scope trigger-sync capture mode (spec
// §trigger-sync): engage-precondition reasons, the pair window derived from
// the trigger budget, and the engaged staleness scale. Types-only so the
// session's gates unit-test without the session (trigger-sync.test.ts) —
// same idiom as match-join.ts / tracker-feed.ts.

import { MATCH_STALE_MS, pairEpochSkewed } from "./match-join";

/** Everything engagement waits on, snapshot-shaped for the retry tick. */
export interface TriggerPreconditions {
  tripleLeased: boolean;
  /** The active controller's `v2Capable`, or null while none is connected. */
  controller: { v2Capable: boolean } | null;
  /** `nativePos.streamId` — null until the lazy/async native sink attach lands. */
  streamId: number | null;
}

/** The `trigger_blocked` reason engagement is waiting on, or null = go.
 *  Checked most-fundamental first so the surfaced reason names the actual
 *  missing piece, not a downstream symptom. */
export function triggerBlockReason(p: TriggerPreconditions): string | null {
  if (!p.tripleLeased) return "no camera triple leased";
  if (!p.controller) return "no controller connected";
  if (!p.controller.v2Capable)
    return "controller firmware is not v2-capable (CMD_FRAME unavailable)";
  if (p.streamId === null) return "native mirror stream not attached yet";
  return null;
}

/** Pair window (ns) = half the trigger interval — see match-join.ts header. */
export function pairWindowNs(minIntervalMs: number): number {
  return (minIntervalMs * 1e6) / 2;
}

/** The onMatch pair gate exactly as the session consults it: only an ENGAGED
 *  trigger session gates on capture epochs — free-run pairing (engaged=false,
 *  or no budget yet) is byte-identical to the pre-trigger-sync behavior. */
export function pairEpochGateTrips(
  engaged: boolean,
  minIntervalMs: number | null,
  epochA: number,
  epochB: number,
): boolean {
  if (!engaged || minIntervalMs === null) return false;
  return pairEpochSkewed(epochA, epochB, pairWindowNs(minIntervalMs));
}

/** Engaged staleness AGE bound: triggered pairs arrive at the scheduler's
 *  interval, not the free-run frame rate, so the free-run horizon would flag
 *  a healthy slow cadence as stale. Seq-gap bound is unchanged (frames are
 *  frames). Free-run keeps {@link MATCH_STALE_MS}. */
export function matchStaleMsFor(
  engaged: boolean,
  minIntervalMs: number | null,
): number {
  return engaged && minIntervalMs !== null
    ? Math.max(MATCH_STALE_MS, 4 * minIntervalMs)
    : MATCH_STALE_MS;
}

/** Achieved-FIN-rate window. The session samples at its 33 ms telemetry
 *  throttle, but a per-publish window that short quantizes hz to 0 or ~30 —
 *  so the window only ROLLS once it spans ≥ `minWindowMs`; between rolls the
 *  last computed rate is republished, and it reads null until the first
 *  window matures (and again after a `reset`). */
export class TriggerRateWindow {
  private fins = 0;
  private startedAt: number | null = null;
  private lastHz: number | null = null;

  constructor(private readonly minWindowMs = 1000) {}

  /** New engagement: drop the held rate, start a fresh maturity window. */
  reset(now: number): void {
    this.fins = 0;
    this.startedAt = now;
    this.lastHz = null;
  }

  onFin(): void {
    this.fins++;
  }

  /** The rate to publish NOW — rolls the window iff it has matured. */
  sample(now: number): number | null {
    if (this.startedAt === null) {
      this.startedAt = now;
      return this.lastHz;
    }
    const windowMs = now - this.startedAt;
    if (windowMs >= this.minWindowMs) {
      this.lastHz = (this.fins * 1000) / windowMs;
      this.fins = 0;
      this.startedAt = now;
    }
    return this.lastHz;
  }
}

/** Curated `trigger_blocked` line for a hardware-trigger enable failure: a
 *  stable prefix + the error's first line, truncated — the raw multi-line
 *  Error.message verbatim broke the status voice. */
export function engageFailureReason(error: unknown, maxLen = 80): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n", 1)[0]!.trim() || "unknown error";
  const clipped =
    firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1)}…` : firstLine;
  return `engage failed: ${clipped}`;
}

/** FIFO op chain serializing engage/disengage: their lease trigger
 *  reconfigures must never interleave (a fast OFF→ON otherwise re-enables
 *  against in-flight disables and can leave one camera untriggered while the
 *  session reports engaged). An op failure reports via `onError` and never
 *  wedges the chain; each queued op awaits every earlier one. */
export function createTriggerOpChain(
  onError: (error: unknown) => void = () => {},
): (op: () => Promise<void>) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (op) => {
    chain = chain.then(op).catch(onError);
    return chain;
  };
}
