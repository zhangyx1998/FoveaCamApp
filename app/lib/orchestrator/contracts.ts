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

/** One `system.perfSnapshot` document — the artifact the zero-copy decision
 *  and round-over-round regression checks consume (§7.3 item 4). */
export type PerfSnapshot = {
  timestamp: string; // ISO 8601
  orchestrator: {
    loopLag: Stat;
  };
  /** Per-topic frame counters, summed across every connected channel. */
  frames: Record<string, { offered: number; sent: number; coalesced: number; bytes: number }>;
  storeHub: { writes: number; updates: number; clears: number };
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
  },
  frames: [] as const,
  commands: {
    connect: cmd<void, boolean>(),
    disconnect: cmd(),
    enable: cmd(),
    disable: cmd(),
    actuate: cmd<
      { left?: Pos; right?: Pos; settle_time?: number },
      { left: Pos; right: Pos; complete_time: number }
    >(),
    trigger: cmd<number>(),
    setBias: cmd<number, number>(),
    setLPF: cmd<number, number>(),
  },
});

export type ControllerContract = typeof controller;
