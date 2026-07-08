// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `buildTopology` (C-24 step 2): pipe-derived nodes + implicit camera roots +
// PHYSICAL producer edges + aggregate consumer sinks + exact bytes-delta MB/s +
// the stage-1 `registerGraphWiring` shim. Driven with fakes (no native core).

import { describe, expect, it, beforeEach } from "vitest";
import {
  buildTopology,
  kindOfPipeId,
  registerGraphWiring,
  resetTopologyStateForTest,
  type PipeListRow,
} from "@orchestrator/graph-topology";
import type { WorkloadSnapshot } from "@lib/orchestrator/stats";

const row = (
  id: string,
  over: Partial<PipeListRow> = {},
): PipeListRow => ({
  id,
  spec: { pixelFormat: "BGRA8", dtype: "U8" },
  epoch: 1,
  consumers: 0,
  closed: false,
  bytesTotal: 0,
  ...over,
});

const load = (name: string, utilization = 0.5, rate = 30): WorkloadSnapshot => ({
  name,
  window: { startedAt: 0, snapshotAt: 1000, uptimeMs: 1000 },
  utilization,
  busyMs: 500,
  inputs: { frame: { count: 40, ratePerSec: 40, maxIntervalMs: 30 } },
  outputs: { shm: { count: 30, ratePerSec: rate, maxIntervalMs: 50 } },
  drops: { total: 2, ratePerSec: 0.1, byReason: {} },
});

describe("kindOfPipeId", () => {
  it("keys on the last segment; fovea slots key on the family", () => {
    expect(kindOfPipeId("camera/123/convert")).toBe("convert");
    expect(kindOfPipeId("camera/123/undistort")).toBe("undistort");
    expect(kindOfPipeId("camera/123/undistort/fovea/2")).toBe("fovea");
    expect(kindOfPipeId("camera/123/convert@Mono8")).toBe("convert");
  });
});

describe("buildTopology", () => {
  beforeEach(resetTopologyStateForTest);

  // Rig regression (2026-07-08): a probe row WITHOUT `drops`/`window` (the
  // legacy flat converter/tracker shape) crashed the fold (`.ratePerSec` of
  // undefined) — blanking the graph + failing snapshot export in every app.
  // The fold must degrade to a partial badge instead.
  it("survives a malformed workload row (no drops/window)", () => {
    const flat = {
      name: "camera/SN1/convert",
      uptimeMs: 1000,
      utilization: 0.5,
      busyMs: 500,
      dropTotal: 1,
      inputs: {},
      outputs: { bgra: { count: 30, ratePerSec: 30 } },
    } as unknown as WorkloadSnapshot;
    const topo = buildTopology({
      listPipes: () => [row("camera/SN1/convert")],
      workloads: () => ({ "camera/SN1/convert": flat }),
    });
    const node = topo.nodes.find((n) => n.id === "camera/SN1/convert")!;
    expect(node.stats).toMatchObject({
      utilization: 0.5,
      ratePerSec: 30,
      dropsPerSec: 0, // degraded, not thrown
      dropsTotal: 0,
    });
  });

  it("derives pipe nodes + implicit camera roots + physical producer edges", () => {
    const t = buildTopology({
      listPipes: () => [
        row("camera/123/convert"),
        row("camera/123/undistort/fovea/0", { epoch: 3 }),
      ],
      workloads: () => ({ "camera/123/convert": load("camera/123/convert", 0.95) }),
    });
    const ids = t.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["camera/123", "camera/123/convert", "camera/123/undistort/fovea/0"]);
    const convert = t.nodes.find((n) => n.id === "camera/123/convert")!;
    expect(convert.kind).toBe("convert");
    expect(convert.stats?.saturated).toBe(true); // ≥0.9 SATURATED semantics
    expect(convert.stats?.ratePerSec).toBe(30);
    const fovea = t.nodes.find((n) => n.id.endsWith("fovea/0"))!;
    expect(fovea.kind).toBe("fovea");
    expect(fovea.epoch).toBe(3);
    // PHYSICAL edges: every brick taps the raw camera (fovea does NOT read the
    // undistort pipe — B's fused map-ROI remap).
    expect(t.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual([
      "camera/123->camera/123/convert",
      "camera/123->camera/123/undistort/fovea/0",
    ]);
  });

  it("emits an aggregate consumer sink + exact bytes-delta rate across snapshots", () => {
    const deps = (bytes: number, at: number) => ({
      listPipes: () => [row("camera/1/convert", { consumers: 2, bytesTotal: bytes })],
      workloads: () => ({}),
      now: () => at,
    });
    buildTopology(deps(1000, 1000)); // warm the delta window
    const t = buildTopology(deps(3000, 2000));
    const sink = t.nodes.find((n) => n.kind === "view")!;
    expect(sink.id).toBe("camera/1/convert/consumers");
    expect(sink.transport).toBe("sink");
    const edge = t.edges.find((e) => e.to === sink.id)!;
    expect(edge.consumers).toBe(2);
    expect(edge.bytesPerSec).toBe(2000); // (3000-1000) bytes over 1s
  });

  it("resets the bytes window on an epoch bump (C-20 slot reuse)", () => {
    buildTopology({
      listPipes: () => [row("camera/1/convert", { consumers: 1, bytesTotal: 5000, epoch: 1 })],
      workloads: () => ({}),
      now: () => 1000,
    });
    const t = buildTopology({
      listPipes: () => [row("camera/1/convert", { consumers: 1, bytesTotal: 100, epoch: 2 })],
      workloads: () => ({}),
      now: () => 2000,
    });
    expect(t.edges.find((e) => e.to.endsWith("/consumers"))!.bytesPerSec).toBeUndefined();
  });

  it("merges registered wiring, folds legacy statsKey, and disposes cleanly", () => {
    const dispose = registerGraphWiring({
      nodes: [
        {
          id: "camera/1/kcf",
          kind: "kcf",
          output: { kind: "track" },
          transport: "native",
          statsKey: "tracking:kcf",
        },
      ],
      edges: [
        { from: "camera/1", to: "camera/1/kcf", port: "in", type: { kind: "track" } },
      ],
    });
    const deps = {
      listPipes: () => [row("camera/1/convert")],
      workloads: () => ({ "tracking:kcf": load("tracking:kcf", 0.3, 25) }),
    };
    const t = buildTopology(deps);
    const kcf = t.nodes.find((n) => n.id === "camera/1/kcf")!;
    expect(kcf.stats?.ratePerSec).toBe(25); // folded via statsKey
    expect(t.edges.some((e) => e.to === "camera/1/kcf")).toBe(true);
    dispose();
    expect(buildTopology(deps).nodes.some((n) => n.id === "camera/1/kcf")).toBe(false);
  });

  it("seq is monotonic across snapshots", () => {
    const deps = { listPipes: () => [], workloads: () => ({}) };
    expect(buildTopology(deps).seq).toBeLessThan(buildTopology(deps).seq);
  });
});
