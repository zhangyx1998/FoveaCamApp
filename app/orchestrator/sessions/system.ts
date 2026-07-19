// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The always-on system session. Process-wide concerns and the `core` smoke
// test; also the cross-process camera handoff (`releaseCameras`) for
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
import { report, spans } from "../diagnostics.js";
import { startLoopLagProbe } from "@lib/util/rolling";

const LOOP_LAG_PUBLISH_INTERVAL_MS = 1000; // ≤ 1 Hz per the perf-substrate constraint

/**
 * Sessions to force-idle before the registry hands cameras back.
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
  /** The live node-graph builder (folded into the 1 Hz perfSnapshot).
   *  Optional so existing tests/callers stay valid; index.ts injects
   *  `buildTopology` over `Pipe.list()` + the workloads map. */
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
          // session control.
          for (const c of cameraOwning()) c.dispose();
          await releaseAll();
        },
        async perfSnapshot(): Promise<PerfSnapshot> {
          // Workload meters — the JS meters from `@orchestrator/metering`, PLUS
          // the native free-running threads probed out-of-loop: the native SHM
          // pipe producers + the KCF tracker, injected via `native-probes` so
          // this builder stays `core`-free. Same `WorkloadSnapshot` shape →
          // the profiler renders native streams identically to JS ones.
          const workloads = { ...workloadsSnapshot(), ...nativeProbes() };
          // The graph fold must never reject the whole snapshot: a single
          // malformed workload row must not blank the profiler or fail export.
          // Degrade to a graph-less snapshot and surface the error instead.
          let topology: GraphTopology | undefined;
          try {
            topology = graph?.(workloads);
          } catch (e) {
            // Route through report() so the failure reaches the renderer error
            // tray instead of dying in an unwatched orchestrator console.
            report("system", `graph topology fold failed: ${(e as Error).message}`);
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
            // Unified time: clock-calibration health rides the
            // same 1 Hz poll — the profiler shows which clocks are aligned.
            clocks: calibrationsSnapshot(),
            // The live node graph, riding the same 1 Hz poll — stats keyed onto
            // nodes from the SAME workloads map above.
            ...(topology ? { graph: topology } : {}),
          };
        },
      },
    };
  });
}
