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
  buildTopologyFromReports,
  kindOfPipeId,
  pipeListToReports,
  registerGraphWiring,
  resetTopologyStateForTest,
  type PipeListRow,
} from "@orchestrator/graph-topology";
import type { NodeReport } from "@lib/orchestrator/graph-contract";
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

// --- Universal node reporting (unified-time-and-topology §6) -----------------

describe("buildTopologyFromReports", () => {
  beforeEach(resetTopologyStateForTest);

  it("reports-first: inputs become edges, stats fold by id when absent", () => {
    const reports: NodeReport[] = [
      {
        id: "camera/9/kcf",
        kind: "kcf",
        transport: "native",
        inputs: [{ from: "camera/9", port: "in", type: { kind: "track" } }],
        output: { kind: "track" },
      },
      {
        id: "win/scope/disparity",
        kind: "disparity",
        transport: "worker",
        owner: "win/scope",
        inputs: [
          { from: "camera/9/kcf", port: "L", type: { kind: "track" } },
          { from: "camera/9/kcf", port: "R", type: { kind: "track" } },
        ],
        output: { kind: "analysis", schema: "vergence" },
      },
    ];
    const t = buildTopologyFromReports(reports, {
      workloads: { "camera/9/kcf": load("camera/9/kcf", 0.3, 25) },
      at: 1000,
    });
    // Nodes ARE the reports; the absent-stats report folded its badge by id.
    expect(t.nodes.map((n) => n.id).sort()).toEqual(["camera/9/kcf", "win/scope/disparity"]);
    expect(t.nodes.find((n) => n.id === "camera/9/kcf")!.stats?.ratePerSec).toBe(25);
    expect(t.nodes.find((n) => n.kind === "disparity")!.owner).toBe("win/scope");
    // Edges are the flattened inputs — one edge per (from, port), verbatim.
    expect(
      t.edges.map((e) => `${e.from}->${e.to}#${e.port}`).sort(),
    ).toEqual([
      "camera/9->camera/9/kcf#in",
      "camera/9/kcf->win/scope/disparity#L",
      "camera/9/kcf->win/scope/disparity#R",
    ]);
    expect(t.edges[0]!.type).toEqual({ kind: "track" });
  });

  it("matches the adapter path exactly: pipeListToReports reproduces buildTopology", () => {
    const rows = [row("camera/123/convert"), row("camera/123/undistort/fovea/0", { epoch: 3 })];
    const workloads = { "camera/123/convert": load("camera/123/convert", 0.95) };
    const viaAdapter = buildTopology({ listPipes: () => rows, workloads: () => workloads });
    resetTopologyStateForTest();
    const viaReports = buildTopologyFromReports(pipeListToReports(rows), {
      workloads,
      at: viaAdapter.at,
    });
    expect(viaReports.nodes).toEqual(viaAdapter.nodes);
    expect(viaReports.edges).toEqual(viaAdapter.edges);
  });

  it("pipe reports with consumers grow the aggregate sink + bytes-delta rate", () => {
    const report = (bytesTotal: number): NodeReport => ({
      id: "camera/1/convert",
      kind: "convert",
      transport: "pipe",
      inputs: [],
      output: { kind: "frame", pixelFormat: "BGRA8", dtype: "U8" },
      epoch: 1,
      pipe: { consumers: 2, bytesTotal },
    });
    buildTopologyFromReports([report(1000)], { workloads: {}, at: 1000 });
    const t = buildTopologyFromReports([report(3000)], { workloads: {}, at: 2000 });
    const sink = t.nodes.find((n) => n.kind === "view")!;
    expect(sink.id).toBe("camera/1/convert/consumers");
    const edge = t.edges.find((e) => e.to === sink.id)!;
    expect(edge.consumers).toBe(2);
    expect(edge.bytesPerSec).toBe(2000);
  });

  it("degrades on malformed reports (missing fields, bad inputs) — never throws", () => {
    const garbage = [
      null,
      { id: 42 },
      { id: "bare" }, // no kind/transport/inputs/output/stats
      {
        id: "camera/7/kcf",
        kind: "kcf",
        transport: "native",
        output: null,
        inputs: [null, { port: "x" }, { from: "camera/7", port: "in", type: { kind: "track" } }],
      },
    ] as unknown as NodeReport[];
    const t = buildTopologyFromReports(garbage, { workloads: {}, at: 1000 });
    const bare = t.nodes.find((n) => n.id === "bare")!;
    expect(bare.output).toBeNull(); // defaulted, not thrown
    expect(bare.transport).toBe("native");
    // Only the well-formed input survived as an edge.
    expect(t.edges).toHaveLength(1);
    expect(t.edges[0]).toMatchObject({ from: "camera/7", to: "camera/7/kcf", port: "in" });
  });
});

describe("buildTopology with real reports (deps.reports)", () => {
  beforeEach(resetTopologyStateForTest);

  it("a real report REPLACES the adapter-synthesized node of the same id", () => {
    const t = buildTopology({
      listPipes: () => [row("camera/1/convert")],
      workloads: () => ({}),
      reports: () => [
        {
          id: "camera/1/convert",
          kind: "convert",
          transport: "native", // post-P3: the brick reports itself
          inputs: [{ from: "camera/1", port: "raw", type: { kind: "frame", pixelFormat: "BayerRG12p", dtype: "U16" } }],
          output: { kind: "frame", pixelFormat: "BGRA8", dtype: "U8" },
          epoch: 7,
        },
      ],
    });
    const convert = t.nodes.find((n) => n.id === "camera/1/convert")!;
    expect(convert.transport).toBe("native"); // real report's fields won
    expect(convert.epoch).toBe(7);
    // The adapter's synthesized camera→convert edge is REPLACED by the
    // report's actual input (port "raw"), not duplicated next to it.
    const edges = t.edges.filter((e) => e.to === "camera/1/convert");
    expect(edges).toHaveLength(1);
    expect(edges[0]!.port).toBe("raw");
    // The adapter-synthesized camera root itself still renders.
    expect(t.nodes.some((n) => n.id === "camera/1")).toBe(true);
  });

  it("a throwing reports() dep degrades to the adapter-only graph", () => {
    const t = buildTopology({
      listPipes: () => [row("camera/1/convert")],
      workloads: () => ({}),
      reports: () => {
        throw new Error("native Topology.report() blew up");
      },
    });
    expect(t.nodes.some((n) => n.id === "camera/1/convert")).toBe(true);
  });

  it("wiring edges into pipe-derived nodes union in (same-layer merge)", () => {
    const dispose = registerGraphWiring({
      nodes: [],
      edges: [
        { from: "win/x/injector", to: "camera/1/convert", port: "aux", type: { kind: "track" } },
      ],
    });
    try {
      const t = buildTopology({
        listPipes: () => [row("camera/1/convert")],
        workloads: () => ({}),
      });
      // The pipe-derived node keeps its identity AND gains the wiring edge.
      const convert = t.nodes.find((n) => n.id === "camera/1/convert")!;
      expect(convert.transport).toBe("pipe");
      const ports = t.edges.filter((e) => e.to === convert.id).map((e) => e.port).sort();
      expect(ports).toEqual(["aux", "in"]);
    } finally {
      dispose();
    }
  });
});
