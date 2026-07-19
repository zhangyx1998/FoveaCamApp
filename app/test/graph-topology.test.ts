// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `buildTopology`: pipe-derived nodes + implicit camera roots +
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
  spec: { pixelFormat: "RGBA8", dtype: "U8" },
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

  // Rig regression: a probe row WITHOUT `drops`/`window` (the
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
    // The statsKey MECHANISM stays (a node may fold from a `:`-family legacy
    // meter name); the fixture no longer uses the dead `tracking:kcf` meter.
    const dispose = registerGraphWiring({
      nodes: [
        {
          id: "camera/1/kcf",
          kind: "kcf",
          output: { kind: "track" },
          transport: "native",
          statsKey: "legacy:kcf",
        },
      ],
      edges: [
        { from: "camera/1", to: "camera/1/kcf", port: "in", type: { kind: "track" } },
      ],
    });
    const deps = {
      listPipes: () => [row("camera/1/convert")],
      workloads: () => ({ "legacy:kcf": load("legacy:kcf", 0.3, 25) }),
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

  it("folds a wiring's serial→role map onto GraphTopology.roles (display-only)", () => {
    const deps = { listPipes: () => [], workloads: () => ({}) };
    expect(buildTopology(deps).roles).toBeUndefined(); // manage-cameras: no roles
    const dispose = registerGraphWiring({
      nodes: [],
      edges: [],
      roles: { "111": "L", "222": "C", "333": "R" },
    });
    expect(buildTopology(deps).roles).toEqual({ "111": "L", "222": "C", "333": "R" });
    dispose();
    expect(buildTopology(deps).roles).toBeUndefined(); // drain removes it
  });

  // Edge-flow spec: every edge reports TX (producer output
  // Hz + bytes/s + maxInterval), RX (consumer per-port input Hz +
  // maxInterval), and a drop rate ONLY on lossy links (tx−rx when both
  // metered). Raw numbers in JSON — the profiler humanizes.
  describe("edge tx/rx/drop flows", () => {
    it("reports TX from the producer meter and RX from the consumer's port meter", () => {
      const reports: NodeReport[] = [
        {
          id: "camera/1/convert",
          kind: "convert",
          transport: "pipe",
          inputs: [],
          output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
          pipe: { consumers: 0, bytesTotal: 0 },
          stats: load("camera/1/convert", 0.3, 60), // outputs 60Hz, maxInterval 50
        },
        {
          id: "win/x/kernel",
          kind: "kernel",
          transport: "worker",
          inputs: [
            {
              from: "camera/1/convert",
              port: "frame", // matches the consumer meter's input key
              type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
              lossy: true,
            },
          ],
          output: null,
          stats: load("win/x/kernel", 0.9, 35), // inputs: frame 40Hz, maxInterval 30
        },
      ];
      const t = buildTopologyFromReports(reports, { workloads: {} });
      const edge = t.edges.find((e) => e.to === "win/x/kernel")!;
      expect(edge.tx).toMatchObject({ hz: 60, maxIntervalMs: 50 });
      expect(edge.rx).toMatchObject({ hz: 40, maxIntervalMs: 30 });
      expect(edge.lossy).toBe(true);
      expect(edge.dropPerSec).toBe(20); // tx 60 − rx 40
    });

    it("a consumer meter with NO input channels yields rx ABSENT, not 0 Hz", () => {
      // The controller's serial meter declares `inputs: []` — it observes the
      // wire, not its position inputs. The pid → controller edge must then
      // show the producer's tx rate alone; a defaulted rx of 0 Hz made the
      // profiler label the live control edge "0Hz" (min(tx, 0)).
      const pidStats = load("win/x/pid", 0.1, 25);
      const reports: NodeReport[] = [
        {
          id: "win/x/pid",
          kind: "pid",
          transport: "native",
          inputs: [],
          output: { kind: "analysis", schema: "pid" },
          stats: pidStats,
        },
        {
          id: "controller",
          kind: "controller",
          transport: "native",
          inputs: [
            {
              from: "win/x/pid",
              port: "volt",
              type: { kind: "analysis", schema: "pid" },
            },
          ],
          output: null,
          stats: { ...load("controller", 0.2, 40), inputs: {} },
        },
      ];
      const t = buildTopologyFromReports(reports, { workloads: {} });
      const edge = t.edges.find((e) => e.to === "controller")!;
      expect(edge.tx?.hz).toBe(25);
      expect(edge.rx).toBeUndefined();
    });

    it("omits drop info on lossless links; sink edges carry TX + bytes delta", () => {
      const mk = (bytesTotal: number) => [
        {
          id: "camera/1/convert",
          kind: "convert",
          transport: "pipe" as const,
          inputs: [
            {
              from: "camera/1",
              port: "in",
              type: { kind: "frame", pixelFormat: "sensor", dtype: "U8" } as const,
              lossy: false, // explicit lossless link
            },
          ],
          output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" } as const,
          pipe: { consumers: 1, bytesTotal },
          stats: load("camera/1/convert", 0.3, 60),
        },
      ];
      buildTopologyFromReports(mk(1000), { workloads: {}, at: 1000 });
      const t = buildTopologyFromReports(mk(3000), { workloads: {}, at: 2000 });
      const inputEdge = t.edges.find((e) => e.to === "camera/1/convert")!;
      expect(inputEdge.lossy).toBeUndefined();
      expect(inputEdge.dropPerSec).toBeUndefined();
      const sink = t.edges.find((e) => e.to.endsWith("/consumers"))!;
      expect(sink.tx).toMatchObject({ hz: 60, bytesPerSec: 2000 });
      expect(sink.lossy).toBe(true); // SHM seqlock is latest-wins by design
    });
  });

  // FIFO edges: a NON-lossy edge whose
  // consumer snapshot carries `queue` reports the high-water mark IN PLACE OF a
  // drop rate. The undistort brick's input off the (pipe-transport) convert
  // brick is the live case — its explicit `lossy: false` must defeat the
  // pipe-producer default.
  describe("FIFO queue edges", () => {
    const producer = (): NodeReport => ({
      id: "camera/1/convert",
      kind: "convert",
      transport: "pipe",
      inputs: [],
      output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
      pipe: { consumers: 0, bytesTotal: 0 },
      stats: load("camera/1/convert", 0.3, 60), // outputs 60Hz
    });

    it("explicit lossy:false defeats the pipe-producer default and attaches the queue", () => {
      const reports: NodeReport[] = [
        producer(),
        {
          id: "camera/1/undistort",
          kind: "undistort",
          transport: "native",
          inputs: [
            {
              from: "camera/1/convert", // pipe producer → default would be lossy
              port: "frame",
              type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
              lossy: false, // FIFO input — explicit flag must win
            },
          ],
          output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
          stats: {
            ...load("camera/1/undistort", 0.7, 60),
            queue: { depth: 3, highWater: 6, capacity: 8 },
          },
        },
      ];
      const t = buildTopologyFromReports(reports, { workloads: {} });
      const edge = t.edges.find((e) => e.to === "camera/1/undistort")!;
      expect(edge.lossy).toBeUndefined(); // explicit false beat the pipe default
      expect(edge.dropPerSec).toBeUndefined(); // non-lossy → no drop rate
      expect(edge.queue).toEqual({ highWater: 6, capacity: 8, depth: 3 });
    });

    it("a lossy edge keeps drops and never attaches queue, even if the snapshot has one", () => {
      const reports: NodeReport[] = [
        producer(),
        {
          id: "win/x/kernel",
          kind: "kernel",
          transport: "worker",
          inputs: [
            {
              from: "camera/1/convert",
              port: "frame",
              type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
              lossy: true,
            },
          ],
          output: null,
          stats: {
            ...load("win/x/kernel", 0.9, 40), // inputs frame 40Hz
            queue: { depth: 1, highWater: 4, capacity: 8 },
          },
        },
      ];
      const t = buildTopologyFromReports(reports, { workloads: {} });
      const edge = t.edges.find((e) => e.to === "win/x/kernel")!;
      expect(edge.lossy).toBe(true);
      expect(edge.dropPerSec).toBe(20); // tx 60 − rx 40, unchanged
      expect(edge.queue).toBeUndefined(); // never on a lossy edge
    });

    it("degrades a malformed queue on a non-lossy edge to absent — never throws", () => {
      const reports: NodeReport[] = [
        producer(),
        {
          id: "camera/1/undistort",
          kind: "undistort",
          transport: "native",
          inputs: [
            {
              from: "camera/1/convert",
              port: "frame",
              type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
              lossy: false,
            },
          ],
          output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
          stats: {
            ...load("camera/1/undistort", 0.7, 60),
            queue: { highWater: 6 } as unknown as WorkloadSnapshot["queue"],
          },
        },
      ];
      const t = buildTopologyFromReports(reports, { workloads: {} });
      const edge = t.edges.find((e) => e.to === "camera/1/undistort")!;
      expect(edge.queue).toBeUndefined();
      expect(edge.dropPerSec).toBeUndefined();
    });
  });
});

// --- Universal node reporting -----------------

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
      output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
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
          transport: "native", // the brick reports itself
          inputs: [{ from: "camera/1", port: "raw", type: { kind: "frame", pixelFormat: "BayerRG12p", dtype: "U16" } }],
          output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
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

  it("edges-only reports union into the owning node without replacing it (native-port-pipe.md)", () => {
    // The session registers the imm NODE (kind/owner) via the wiring shim; the
    // native port link self-reports the kcf → imm EDGE as an edges-only row in
    // the REAL layer. The edge must land on the node WITHOUT the real-layer
    // row replacing the wiring node's fields (the plain across-layer rule).
    const dispose = registerGraphWiring({
      nodes: [
        {
          id: "camera/1/undistort/kcf/imm",
          kind: "imm",
          owner: "win/disparity-scope",
          output: { kind: "track" },
          transport: "native",
        },
      ],
      edges: [],
    });
    try {
      const t = buildTopology({
        listPipes: () => [],
        workloads: () => ({}),
        reports: () => [
          {
            id: "camera/1/undistort/kcf/imm",
            kind: "",
            transport: "native",
            edgesOnly: true,
            inputs: [
              {
                from: "camera/1/undistort/kcf",
                port: "measure",
                type: { kind: "track" },
                lossy: true,
              },
            ],
            output: null,
          },
        ],
      });
      const imm = t.nodes.find((n) => n.id === "camera/1/undistort/kcf/imm")!;
      expect(imm.kind).toBe("imm"); // wiring node fields SURVIVE the edge row
      expect(imm.owner).toBe("win/disparity-scope");
      const edge = t.edges.find(
        (e) => e.from === "camera/1/undistort/kcf" && e.to === imm.id,
      )!;
      expect(edge.port).toBe("measure");
      expect(edge.lossy).toBe(true);
    } finally {
      dispose();
    }
  });

  it("an orphan edges-only report degrades to a placeholder node (kind from the id path)", () => {
    const t = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      reports: () => [
        {
          id: "camera/9/undistort/kcf/imm",
          kind: "",
          transport: "native",
          edgesOnly: true,
          inputs: [
            {
              from: "camera/9/undistort/kcf",
              port: "measure",
              type: { kind: "track" },
              lossy: false,
              queue: { highWater: 3, capacity: 8 },
            },
          ],
          output: null,
        },
      ],
    });
    const node = t.nodes.find((n) => n.id === "camera/9/undistort/kcf/imm")!;
    expect(node.kind).toBe("imm"); // kindOfPipeId fallback
    // A fifo link's own per-edge queue stats ride the edge (hwm treatment).
    const edge = t.edges.find((e) => e.to === node.id)!;
    expect(edge.queue).toEqual({ highWater: 3, capacity: 8 });
    expect(edge.lossy).toBeUndefined();
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
