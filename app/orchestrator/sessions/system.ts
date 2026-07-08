// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The always-on system session. Process-wide concerns and the `core` smoke
// test; also the cross-process camera handoff (`releaseCameras`, §12.1 C2) for
// renderer modules that still open cameras directly.

import { defineSession, type ServerSession } from "../runtime.js";
import { system, type PerfSnapshot } from "@lib/orchestrator/contracts";
import type { GraphTopology } from "@lib/orchestrator/graph-contract";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";
import type { FrameTopicStats } from "@lib/orchestrator/protocol";
import { listCameraInfo } from "../camera.js";
import { workloadsSnapshot } from "../metering.js";
import { nativeProbes } from "../native-probes.js";
import { releaseAll } from "../registry.js";
import { writeCounts } from "../store-hub.js";
import { calibrationsSnapshot } from "../time-align.js";
import { spans } from "../diagnostics.js";
import { startLoopLagProbe } from "@lib/util/rolling";

const LOOP_LAG_PUBLISH_INTERVAL_MS = 1000; // ≤ 1 Hz per the perf-substrate constraint

/**
 * Sessions to force-idle before the registry hands cameras back (§12.3 R4).
 * `frameStats` aggregates every connected channel's per-topic frame counters
 * (`Hub.frameStatsSnapshot`) — kept as a callback rather than passing `Hub`
 * itself so this session stays easy to unit-test against a stub.
 */
export function systemSession(
  cameraOwning: () => Iterable<{ dispose(): void }>,
  frameStats: () => Record<
    string,
    FrameTopicStats
  >,
  /** The live node-graph builder (C-24, ruled Q2: folded into the 1 Hz
   *  perfSnapshot). Optional so existing tests/callers stay valid; index.ts
   *  injects `buildTopology` over `Pipe.list()` + the workloads map. */
  graph?: (workloads: Record<string, WorkloadSnapshot>) => GraphTopology,
): ServerSession<typeof system> {
  return defineSession("system", system, (s) => {
    // Never stopped: `system` is the always-on session (no `activate`/`idle`)
    // — this probe lives for the process's whole lifetime, same as the
    // process itself.
    const loopLag = startLoopLagProbe();
    setInterval(() => {
      s.telemetry({ loopLag: { mean: loopLag.stats.mean, max: loopLag.stats.max } });
      loopLag.stats.resetMax();
    }, LOOP_LAG_PUBLISH_INTERVAL_MS);

    return {
      commands: {
        listCameras: listCameraInfo,
        async releaseCameras() {
          // Session interest is the primary lifetime authority: idle every
          // camera-owning session first (orderly lease release) so a renderer
          // needing exclusive access isn't racing an async idle release.
          // `registry.releaseAll()` is a backstop for any handle outside
          // session control. See §12.1 C2 / §12.3 R4.
          for (const c of cameraOwning()) c.dispose();
          await releaseAll();
        },
        async perfSnapshot(): Promise<PerfSnapshot> {
          // Workload meters (docs/history/refactor/workload-metering.md §2) — the JS
          // meters from `@orchestrator/metering`, PLUS the native free-running
          // threads probed out-of-loop (WS1 real-1c/1d, A-24 Stage 3): C's SHM
          // pipe producers + B's KCF tracker, injected via `native-probes` so
          // this builder stays `core`-free. Same `WorkloadSnapshot` shape →
          // the profiler renders native streams identically to JS ones.
          const workloads = { ...workloadsSnapshot(), ...nativeProbes() };
          // The graph fold must never reject the whole snapshot: a single
          // malformed workload row once blanked the profiler AND failed
          // every export in every app (rig 2026-07-08). Degrade to a
          // graph-less snapshot and surface the error instead.
          let topology: GraphTopology | undefined;
          try {
            topology = graph?.(workloads);
          } catch (e) {
            console.error("[system] graph topology fold failed:", e);
          }
          return {
            timestamp: new Date().toISOString(),
            orchestrator: {
              loopLag: { mean: loopLag.stats.mean, max: loopLag.stats.max },
            },
            frames: frameStats(),
            workloads,
            storeHub: writeCounts(),
            spans: [...spans()],
            // Unified time (proposal §3): clock-calibration health rides the
            // same 1 Hz poll — the profiler shows which clocks are aligned.
            clocks: calibrationsSnapshot(),
            // C-24: the live node graph, riding the same 1 Hz poll (ruled Q2) —
            // stats keyed onto nodes from the SAME workloads map above.
            ...(topology ? { graph: topology } : {}),
          };
        },
      },
    };
  });
}
