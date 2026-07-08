// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Session contracts: the single source of truth shared by the orchestrator
// (which implements them) and the renderer (which imports their `typeof`).
// As each sub-app is migrated, add its contract here (or co-locate it in the
// module and re-export) so both ends stay in lock-step.

import { cmd, defineContract } from "./protocol.js";
import type { FrameTopicStats } from "./protocol.js";
import type { GraphTopology } from "./graph-contract.js";
import type { Pos } from "../controller-codec.js";

/** Minimal camera descriptor — plain data, safe to cross the boundary. */
export type CameraInfo = {
  serial: string;
  model: string;
  vendor: string;
};

/** Rolling mean/max pair, the shape every perf-substrate stat publishes as
 *  (docs/refactor/orchestrator.md §7.3). */
export type Stat = { mean: number; max: number };

/** A structured timing measurement (§7.1 S5) — boot phases, per-activation
 *  camera/calibration work, controller connect. Mirrors
 *  `orchestrator/diagnostics.ts`'s `Span`; duplicated here (not imported)
 *  since `contracts.ts` is the renderer-safe boundary and `diagnostics.ts`
 *  is orchestrator-only. */
export type Span = { name: string; ms: number; meta?: Record<string, unknown>; t: number };

/** One workload counter reading (docs/refactor/workload-metering.md §2).
 *  Mirrors `orchestrator/metering.ts`'s snapshot shapes; duplicated here (not
 *  imported) for the same reason as `Span` — `contracts.ts` is the
 *  renderer-safe boundary and `metering.ts` is orchestrator-only. */
// C-18: `maxIntervalMs` = largest gap (ms) between consecutive events over the
// trailing window (mirrors `stats.WorkloadStreamStat`/`metering.ts`). Optional
// so pre-C-18 snapshots still fit; the profiler reads it typed, not `as any`.
export type WorkloadCounterSnapshot = {
  count: number;
  ratePerSec: number;
  maxIntervalMs?: number;
};

/** One workload meter's aggregated document — `system.perfSnapshot`'s
 *  `workloads` values, keyed by workload name. */
export type WorkloadSnapshot = {
  name: string;
  window: { startedAt: number; snapshotAt: number; uptimeMs: number };
  /** Busy-time fraction of `window.uptimeMs`, clamped to [0, 1]. */
  utilization: number;
  busyMs: number;
  inputs: Record<string, WorkloadCounterSnapshot>;
  outputs: Record<string, WorkloadCounterSnapshot>;
  drops: { total: number; ratePerSec: number; byReason: Record<string, number> };
};

/** One `system.perfSnapshot` document — the artifact the zero-copy decision
 *  and round-over-round regression checks consume (§7.3 item 4). */
export type PerfSnapshot = {
  timestamp: string; // ISO 8601
  orchestrator: {
    loopLag: Stat;
  };
  /** Per-topic frame counters/timing, summed across every connected channel. */
  frames: Record<string, FrameTopicStats>;
  /** Per-name workload meters (native tracker/pipe thread probes, recorder
   *  workers — docs/refactor/workload-metering.md). */
  workloads: Record<string, WorkloadSnapshot>;
  storeHub: { writes: number; updates: number; clears: number };
  /** Ring-buffer snapshot of recent boot/activation/connect timings (§7.1 S5). */
  spans: Span[];
  /** The live stream node graph (C-24, ruled Q2: folded into this 1 Hz poll).
   *  Optional so pre-graph snapshot documents stay valid. */
  graph?: GraphTopology;
};

/**
 * The always-on session. Owns process-wide concerns and is the smoke test that
 * `core` loads and runs inside the orchestrator process.
 */
export const system = defineContract({
  state: {},
  telemetry: {
    cameraCount: 0,
    // Event-loop lag probe (§7.3 item 1) — the "own libuv loop" metric.
    // Always-on, ≤ 1 Hz publish rate per the perf-substrate constraints.
    loopLag: { mean: 0, max: 0 } as Stat,
  },
  frames: [] as const,
  commands: {
    listCameras: cmd<void, CameraInfo[]>(),
    /**
     * Force-release every camera the orchestrator holds and resolve once the
     * native handles are closed. Non-migrated renderer modules call this before
     * opening cameras directly, so the orchestrator hands back the per-process
     * exclusive device claim (see camera registry).
     */
    releaseCameras: cmd<void, void>(),
    /** One-shot aggregated perf document — see `PerfSnapshot`. */
    perfSnapshot: cmd<void, PerfSnapshot>(),
  },
});

export type SystemContract = typeof system;

/**
 * MEMS mirror controller (serial). A global singleton — the orchestrator owns
 * the serial device; renderers connect/enable/actuate via commands and read
 * status via telemetry. The session stays idle until `connect` is commanded
 * (the title-bar `Controller.vue`, a thin client over this session, connects on
 * mount).
 */
/** One live CMD_STREAM's telemetry row — the profiler's per-stream table
 *  (docs/refactor/orchestrator.md §7.1 S4 added scope). */
export type StreamStat = { id: number; hz: number; left: Pos; right: Pos };

export const controller = defineContract({
  state: { vendorId: "16c0", productId: "0483" },
  telemetry: {
    connected: false as boolean,
    pending: false as boolean,
    enabled: false as boolean,
    dv: 0,
    pos: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } } as {
      left: Pos;
      right: Pos;
    },
    // Serial + per-stream probes (§7.1 S4 added scope) — sampled ~2 Hz by
    // the session while connected; rates derived from `Device.stats`'
    // cumulative counters (native, landed with the synced-capture thread's
    // P4.1) by diffing successive samples.
    serialRate: {
      txBytesPerSec: 0,
      rxBytesPerSec: 0,
      txPacketsPerSec: 0,
      rxPacketsPerSec: 0,
    },
    streams: [] as StreamStat[],
  },
  frames: [] as const,
  commands: {
    connect: cmd<void, boolean>(),
    disconnect: cmd(),
    enable: cmd(),
    disable: cmd(),
    actuate: cmd<
      { left?: Pos; right?: Pos; settleTime?: number },
      { left: Pos; right: Pos; completeTime: number }
    >(),
    trigger: cmd<number>(),
    setBias: cmd<number, number>(),
    setLPF: cmd<number, number>(),
  },
});

export type ControllerContract = typeof controller;

// The `viewer` session contract (Stage 5 A-11/C-8 pinned contract) lives in
// `./viewer-contract.ts` — its own file so the two concurrent threads (C-8
// session, A-11 window) never edit the same file; both import that single
// definition, so the compiler enforces the pin.
