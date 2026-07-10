// A-33 profiler graph panel — the pure view-model layer (`graph-view.ts`):
// Stage-1 topology derivation from mock workload rows + pipe adverts, the
// cytoscape element reduction, and the membership key that gates re-layout.
// This IS the panel's mock-data story: the same mocks drive the component.

import { describe, expect, it } from "vitest";
import {
  collapseConsumerSinks,
  deriveIdle,
  deriveTopology,
  edgeDetail,
  edgeLabel,
  edgeWarns,
  effectiveOpacity,
  hoverDistances,
  hoverOpacity,
  HOVER_OPACITY_FLOOR,
  IDLE_OPACITY,
  isBackpressured,
  isDropping,
  membershipKey,
  nodeDetail,
  nodeLabel,
  RENDERER_ID,
  selectTopology,
  toElements,
  type HoverDetail,
} from "@src/profiler/graph-view";
import type { GraphEdge, GraphNode, GraphTopology, StreamType } from "@lib/orchestrator/graph-contract";
import type { WorkloadRow } from "@src/profiler/workload-view";
import type { PipeAdvert } from "@lib/orchestrator/pipe-contract";

function row(name: string, over: Partial<WorkloadRow> = {}): WorkloadRow {
  return {
    name,
    utilization: 0.1,
    interval: true,
    busyMs: 100,
    uptimeMs: 1000,
    inputs: [],
    outputs: [{ name: "out", count: 100, ratePerSec: 55, maxIntervalMs: 20, stalled: false }],
    drops: { total: 0, ratePerSec: 0, byReason: [] },
    ...over,
  };
}

function advert(pipeId: string, epoch = 1): PipeAdvert {
  return {
    epoch,
    spec: {
      id: pipeId,
      pixelFormat: "RGBA8",
      dtype: "U8",
      width: 640,
      height: 480,
      channels: 4,
      stride: 2560,
      bytesPerFrame: 1228800,
      ringDepth: 4,
    },
  };
}

const PIPES = {
  "camera/123/convert": advert("camera/123/convert"),
  "camera/123/undistort": advert("camera/123/undistort"),
};

describe("deriveTopology — Stage 1", () => {
  it("builds camera→convert and camera→undistort bricks from pipe adverts", () => {
    const t = deriveTopology([], PIPES, 1, 0);
    const ids = t.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["camera/123", "camera/123/convert", "camera/123/undistort"]);
    expect(t.edges).toEqual([
      expect.objectContaining({ from: "camera/123", to: "camera/123/convert", port: "in" }),
      expect.objectContaining({ from: "camera/123", to: "camera/123/undistort", port: "in" }),
    ]);
    const convert = t.nodes.find((n) => n.id === "camera/123/convert")!;
    expect(convert.kind).toBe("convert");
    expect(convert.transport).toBe("pipe");
    expect(convert.output).toEqual({ kind: "frame", pixelFormat: "RGBA8", dtype: "U8" });
  });

  it("attaches pipe-meter stats to the owning brick and flags saturation", () => {
    const t = deriveTopology(
      [row("camera/123/convert", { utilization: 0.97 }), row("camera/123/undistort", { utilization: 0.5 })],
      PIPES,
      1,
      0,
    );
    const convert = t.nodes.find((n) => n.id === "camera/123/convert")!;
    expect(convert.stats).toMatchObject({ utilization: 0.97, ratePerSec: 55, saturated: true });
    const und = t.nodes.find((n) => n.id === "camera/123/undistort")!;
    expect(und.stats).toMatchObject({ utilization: 0.5, saturated: false });
  });

  it("renders dynamic fovea pipes with the PHYSICAL camera edge (nodeId.fovea note)", () => {
    const foveaId = "camera/123/undistort/fovea/2";
    const t = deriveTopology([], { ...PIPES, [foveaId]: advert(foveaId, 3) }, 1, 0);
    const fovea = t.nodes.find((n) => n.id === foveaId)!;
    expect(fovea.kind).toBe("fovea"); // last non-numeric segment
    expect(fovea.epoch).toBe(3);
    // Physical edge camera→fovea (B's fused remap taps the raw stream), not
    // undistort→fovea despite the nested id.
    expect(t.edges).toContainEqual(
      expect.objectContaining({ from: "camera/123", to: foveaId }),
    );
  });

  it("maps known standalone meters (controller) and keeps unknown ones visible", () => {
    const t = deriveTopology(
      [
        row("controller:/dev/tty.usb"),
        row("mystery:thing"), // unknown pattern — must still land on the graph
      ],
      {},
      1,
      0,
    );
    expect(t.nodes.find((n) => n.id === "controller/dev/tty.usb")!.kind).toBe("controller");
    expect(t.nodes.find((n) => n.id === "mystery/thing")).toBeTruthy();
  });

  // The legacy `tracking:kcf` recognition is PRUNED (tracking-single app
  // deleted, 6f8097c) — KCF meters are path-like node ids now; the "/"
  // branch's kindOf derivation must cover every KCF flavor.
  it("derives KCF kinds from path-like meter names (legacy tracking:kcf pruned)", () => {
    const t = deriveTopology(
      [row("camera/123/kcf"), row("camera/123/kcf-multi"), row("camera/123/undistort/kcf")],
      {},
      1,
      0,
    );
    expect(t.nodes.find((n) => n.id === "camera/123/kcf")!.kind).toBe("kcf");
    expect(t.nodes.find((n) => n.id === "camera/123/kcf-multi")!.kind).toBe("kcf-multi");
    expect(t.nodes.find((n) => n.id === "camera/123/undistort/kcf")!.kind).toBe("kcf");
    // A stray legacy-family name no longer maps to a kcf node — it degrades to
    // a generic metered node (still visible, never special-cased).
    const legacy = deriveTopology([row("tracking:kcf")], {}, 1, 0);
    expect(legacy.nodes.find((n) => n.id === "tracking/kcf")!.kind).toBe("tracking");
  });

});

describe("membershipKey / toElements — layout stability", () => {
  it("is stable across stats-only refreshes, changes on membership/epoch churn", () => {
    const a = deriveTopology([row("camera/123/convert", { utilization: 0.2 })], PIPES, 1, 0);
    const b = deriveTopology([row("camera/123/convert", { utilization: 0.95 })], PIPES, 2, 1000);
    expect(membershipKey(a)).toBe(membershipKey(b)); // stats change ≠ re-layout

    const withKcf = deriveTopology([row("camera/123/convert"), row("camera/123/kcf")], PIPES, 3, 2000);
    expect(membershipKey(withKcf)).not.toBe(membershipKey(a)); // node appeared

    const bumped = deriveTopology([], { "camera/123/convert": advert("camera/123/convert", 2), "camera/123/undistort": advert("camera/123/undistort") }, 4, 3000);
    expect(membershipKey(bumped)).not.toBe(membershipKey(deriveTopology([], PIPES, 5, 4000))); // epoch bump
  });

  it("reduces to cytoscape elements (name-only labels, metrics in the hover detail) and skips dangling edges", () => {
    const t = deriveTopology([row("camera/123/convert", { utilization: 0.97 })], PIPES, 1, 0);
    t.edges.push({ from: "camera/123", to: "ghost/node", port: "in", type: { kind: "track" } });
    const els = toElements(t);
    expect(els.filter((e) => e.group === "nodes")).toHaveLength(3);
    // The dangling edge is dropped; the two structural edges survive.
    expect(els.filter((e) => e.group === "edges")).toHaveLength(2);
    const convert = els.find((e) => e.data.id === "camera/123/convert")!;
    expect(convert.classes).toBe("saturated");
    // Always-on label = name only; util/rate live in the hover card rows.
    expect(convert.data.label).toBe("123/convert");
    const detail = convert.data.detail as HoverDetail;
    expect(detail.title).toBe("camera/123/convert");
    expect(detail.rows).toContainEqual(["utilization", "97% — SATURATED"]);
    expect(detail.rows).toContainEqual(["rate", "55.00 Hz"]);
  });

  it("labels nodes name-only; unmetered hover detail still carries id + kind", () => {
    const t = deriveTopology([], PIPES, 1, 0);
    const camera = t.nodes.find((n) => n.id === "camera/123")!;
    expect(nodeLabel(camera)).toBe("camera/123");
    const detail = nodeDetail(camera);
    expect(detail.title).toBe("camera/123");
    expect(detail.rows).toEqual([["kind", "camera"]]);
  });
});

describe("Stage-2 source selection + served-shape rendering (A-36)", () => {
  // Mirrors C-24's graphTopology() emission (orchestrator/graph-topology.ts):
  // camera root, pipe brick with epoch+stats, aggregate consumer sink with the
  // exact byte-rate edge, and a stage-1 session wiring under win/<windowId>.
  const served = (): import("@lib/orchestrator/graph-contract").GraphTopology => ({
    seq: 42,
    at: 1000,
    nodes: [
      {
        id: "camera/123",
        kind: "camera",
        output: { kind: "frame", pixelFormat: "sensor", dtype: "U8" },
        transport: "native",
      },
      {
        id: "camera/123/convert",
        kind: "convert",
        output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
        transport: "pipe",
        epoch: 2,
        stats: { utilization: 0.35, ratePerSec: 55, saturated: false },
      },
      { id: "camera/123/convert/consumers", kind: "view", output: null, transport: "sink" },
      {
        id: "win/scope-1/kcf",
        kind: "kcf",
        output: { kind: "track" },
        transport: "native",
        owner: "win/scope-1",
        stats: { utilization: 0.95, ratePerSec: 54, saturated: true },
      },
    ],
    edges: [
      {
        from: "camera/123",
        to: "camera/123/convert",
        port: "in",
        type: { kind: "frame", pixelFormat: "sensor", dtype: "U8" },
        ratePerSec: 55,
      },
      {
        from: "camera/123/convert",
        to: "camera/123/convert/consumers",
        port: "in",
        type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
        consumers: 2,
        ratePerSec: 55,
        bytesPerSec: 55_000_000,
      },
    ],
  });

  it("prefers the served topology and never evaluates the fallback", () => {
    const t = served();
    let fallbackCalls = 0;
    const picked = selectTopology(t, () => {
      fallbackCalls++;
      return deriveTopology([], {}, 1, 0);
    });
    expect(picked).toBe(t);
    expect(fallbackCalls).toBe(0);
  });

  it("falls back to the derivation when the snapshot has no graph", () => {
    const picked = selectTopology(undefined, () => deriveTopology([], PIPES, 7, 500));
    expect(picked.seq).toBe(7);
    expect(picked.nodes.some((n) => n.id === "camera/123/convert")).toBe(true);
  });

  it("collapses the SHM consumer sink into one renderer node, keeps win/ nodes + byte-rate edges", () => {
    const els = toElements(served());
    // The anonymous camera/123/convert/consumers sink is gone; its pipe keeps
    // its own fan-in edge into the single renderer node.
    expect(els.find((e) => e.data.id === "camera/123/convert/consumers")).toBeUndefined();
    const renderer = els.find((e) => e.data.id === RENDERER_ID)!;
    expect(renderer.data.label).toBe("renderer");
    // The wired kcf node under win/ carries its saturation class; the
    // metrics moved into the hover card.
    const kcf = els.find((e) => e.data.id === "win/scope-1/kcf")!;
    expect(kcf.classes).toBe("saturated");
    expect(kcf.data.label).toBe("scope-1/kcf");
    expect((kcf.data.detail as HoverDetail).rows).toContainEqual([
      "utilization",
      "95% — SATURATED",
    ]);
    // The consumer edge (now → renderer) label shows the effective rate only;
    // the byte rate and consumer refcount live in the hover card.
    const edge = els.find((e) => e.data.id === `edge:camera/123/convert->${RENDERER_ID}#in`)!;
    expect(edge.data.label).toBe("55.00 Hz");
    const detail = edge.data.detail as HoverDetail;
    expect(detail.rows).toContainEqual(["tx", "55.00 Hz · 55.00 MB/s"]);
    expect(detail.rows).toContainEqual(["consumers", "×2"]);
    // Membership key includes the pipe's epoch (re-advertise = re-layout).
    expect(membershipKey(served())).toContain("camera/123/convert#2");
  });
});

describe("edge flow labels (tx/rx/drop — 4732f64 contract)", () => {
  const base: GraphEdge = {
    from: "camera/123/convert",
    to: "win/t-1/kcf",
    port: "in",
    type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
  };

  it("labels the EFFECTIVE rate only: min(tx, rx), single direction when one is metered", () => {
    const both: GraphEdge = {
      ...base,
      tx: { hz: 59.9, bytesPerSec: 377_000_000, maxIntervalMs: 25 },
      rx: { hz: 35.2 },
    };
    expect(edgeLabel(both)).toBe("35.20 Hz"); // min wins
    const txOnly: GraphEdge = { ...base, tx: { hz: 60 } };
    expect(edgeLabel(txOnly)).toBe("60.00 Hz");
    const rxOnly: GraphEdge = { ...base, rx: { hz: 35.3 } };
    expect(edgeLabel(rxOnly)).toBe("35.30 Hz");
    const unmetered: GraphEdge = { ...base };
    expect(edgeLabel(unmetered)).toBe("");
  });

  it("keeps drop semantics: isDropping only when lossy AND actually dropping; label stays min-rate", () => {
    const dropping: GraphEdge = {
      ...base,
      tx: { hz: 60 },
      rx: { hz: 35.3 },
      dropPerSec: 24.7,
      lossy: true,
    };
    expect(isDropping(dropping)).toBe(true);
    expect(edgeLabel(dropping)).toBe("35.30 Hz"); // marker moved to class + hover

    // Lossless link with a rate gap: drop semantics don't apply.
    const lossless: GraphEdge = { ...base, tx: { hz: 60 }, rx: { hz: 35 }, dropPerSec: 25 };
    expect(isDropping(lossless)).toBe(false);

    // Lossy but idle: quiet.
    const idle: GraphEdge = { ...base, tx: { hz: 60 }, lossy: true, dropPerSec: 0 };
    expect(isDropping(idle)).toBe(false);
  });

  it("falls back to the deprecated ratePerSec/bytesPerSec mirrors as tx-only", () => {
    const legacy: GraphEdge = { ...base, ratePerSec: 55, bytesPerSec: 55_000_000, consumers: 2 };
    expect(edgeLabel(legacy)).toBe("55.00 Hz");
    const preferred: GraphEdge = { ...legacy, tx: { hz: 60 } };
    expect(edgeLabel(preferred)).toBe("60.00 Hz"); // tx wins over mirrors
  });

  it("structures the hover detail: directional rows, worst gaps, drops, consumers", () => {
    const e: GraphEdge = {
      ...base,
      tx: { hz: 59.9, bytesPerSec: 377_000_000, maxIntervalMs: 25 },
      rx: { hz: 35.2, maxIntervalMs: 112 },
      dropPerSec: 24.7,
      lossy: true,
      consumers: 2,
    };
    expect(edgeLabel(e)).not.toContain("ms");
    const detail = edgeDetail(e);
    expect(detail.title).toBe("camera/123/convert → win/t-1/kcf");
    expect(detail.rows).toEqual([
      ["port", "in"],
      ["tx", "59.90 Hz · 377.00 MB/s"],
      ["rx", "35.20 Hz"],
      ["worst gap", "↑ 25 ms · ↓ 112 ms"],
      ["drops", "24.7/s (lossy latest-wins)"],
      ["consumers", "×2"],
    ]);
  });

  it("toElements marks dropping edges with the warning class + detail data", () => {
    const t = deriveTopology([], PIPES, 1, 0);
    t.edges[0] = { ...t.edges[0], tx: { hz: 60 }, rx: { hz: 30 }, dropPerSec: 30, lossy: true };
    const els = toElements(t);
    const edges = els.filter((e) => e.group === "edges");
    expect(edges[0].classes).toBe("dropping");
    expect((edges[0].data.detail as HoverDetail).rows).toContainEqual([
      "drops",
      "30.0/s (lossy latest-wins)",
    ]);
    expect(edges[1].classes).toBe(""); // unmetered edge stays quiet
  });
});

describe("FIFO queue edges (controller-node-and-fifo-edges §2)", () => {
  const fifo: GraphEdge = {
    from: "camera/123/convert",
    to: "camera/123/undistort",
    port: "in",
    type: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" },
    tx: { hz: 60, maxIntervalMs: 20 },
    rx: { hz: 60 },
    queue: { highWater: 6, capacity: 8, depth: 3 },
  };

  it("hover shows the queue row IN PLACE OF the drops row", () => {
    const detail = edgeDetail(fifo);
    expect(detail.rows).toContainEqual(["queue", "hwm 6 / cap 8 (10s) · now 3"]);
    expect(detail.rows.some(([label]) => label === "drops")).toBe(false);
  });

  it("omits the depth suffix when depth is absent", () => {
    const detail = edgeDetail({ ...fifo, queue: { highWater: 2, capacity: 8 } });
    expect(detail.rows).toContainEqual(["queue", "hwm 2 / cap 8 (10s)"]);
  });

  it("warns only when hwm >= capacity (backpressure engaged), never as a drop", () => {
    expect(isBackpressured(fifo)).toBe(false);
    expect(edgeWarns(fifo)).toBe(false);
    const full: GraphEdge = { ...fifo, queue: { highWater: 8, capacity: 8, depth: 8 } };
    expect(isBackpressured(full)).toBe(true);
    expect(edgeWarns(full)).toBe(true);
    expect(isDropping(full)).toBe(false); // a FIFO edge never reads as a drop
  });

  it("toElements marks a backpressured FIFO edge with the warning class + queue detail", () => {
    const t = deriveTopology([], PIPES, 1, 0);
    t.edges[0] = { ...t.edges[0], queue: { highWater: 8, capacity: 8, depth: 8 } };
    const edges = toElements(t).filter((e) => e.group === "edges");
    expect(edges[0].classes).toBe("dropping"); // shared warn styling
    expect((edges[0].data.detail as HoverDetail).rows).toContainEqual([
      "queue",
      "hwm 8 / cap 8 (10s) · now 8",
    ]);
    expect(edges[1].classes).toBe(""); // the queue-less edge stays quiet
  });
});

const FR: StreamType = { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" };

describe("deriveIdle — idle vs stalled (user 2026-07-10)", () => {
  // camera → convert(pipe, 0 Hz) → renderer(sink), the convert→renderer edge
  // carrying the pipe's live consumer refcount.
  const chain = (consumers: number): GraphTopology => ({
    seq: 1,
    at: 0,
    nodes: [
      { id: "camera/1", kind: "camera", output: FR, transport: "native" },
      { id: "camera/1/convert", kind: "convert", output: FR, transport: "pipe", stats: { ratePerSec: 0 } },
      { id: RENDERER_ID, kind: "renderer", output: null, transport: "sink" },
    ],
    edges: [
      { from: "camera/1", to: "camera/1/convert", port: "in", type: FR },
      { from: "camera/1/convert", to: RENDERER_ID, port: "in", type: FR, consumers },
    ],
  });

  it("marks the whole upstream chain idle when the pipe has zero consumers", () => {
    const idle = deriveIdle(chain(0));
    expect(idle.nodes).toEqual(new Set(["camera/1", "camera/1/convert", RENDERER_ID]));
    expect(idle.edges).toEqual(
      new Set(["edge:camera/1->camera/1/convert#in", `edge:camera/1/convert->${RENDERER_ID}#in`]),
    );
  });

  it("renders the whole demanded path LIVE once one consumer appears", () => {
    const idle = deriveIdle(chain(1));
    expect(idle.nodes.size).toBe(0);
    expect(idle.edges.size).toBe(0);
  });

  it("keeps a zero-rate producer STALLED (not idle) while a downstream actively consumes", () => {
    // kcf produces 0 Hz into a controller actively consuming — demand exists, so
    // kcf stays live/red, never dimmed to idle (the kcf→pid false-idle fix).
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "camera/1/kcf", kind: "kcf", output: { kind: "track" }, transport: "native", stats: { ratePerSec: 0 } },
        { id: "controller", kind: "controller", output: null, transport: "sink", stats: { ratePerSec: 30 } },
      ],
      edges: [{ from: "camera/1/kcf", to: "controller", port: "in", type: { kind: "track" } }],
    };
    const idle = deriveIdle(t);
    expect(idle.nodes.has("camera/1/kcf")).toBe(false);
    expect(idle.edges.size).toBe(0);
  });

  it("never paints a pegged (saturated/util>0) node idle — a stuck loop is a STALL", () => {
    // 0 Hz output, 0 consumers downstream — but 95% util: a compute loop
    // burning CPU while emitting nothing. Must keep the red accent, not the
    // parked slate (UI/UX review 2026-07-10 fix: util vetoes idle).
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        {
          id: "camera/1/convert",
          kind: "convert",
          output: FR,
          transport: "pipe",
          stats: { ratePerSec: 0, utilization: 0.95, saturated: true },
          pipe: { consumers: 0, bytesTotal: 0 },
        },
      ],
      edges: [],
    };
    const idle = deriveIdle(t);
    expect(idle.nodes.has("camera/1/convert")).toBe(false);
  });

  it("marks a producer idle when its ONLY consumer is itself idle (hollow demand)", () => {
    // undistort → fovea (consumers:1) → renderer (consumers:0). undistort HAS a
    // subscriber, but that subscriber is parked, so undistort is idle too.
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "camera/1/undistort", kind: "undistort", output: FR, transport: "pipe", stats: { ratePerSec: 0 } },
        { id: "camera/1/undistort/fovea/1", kind: "fovea", output: FR, transport: "pipe", stats: { ratePerSec: 0 } },
        { id: RENDERER_ID, kind: "renderer", output: null, transport: "sink" },
      ],
      edges: [
        { from: "camera/1/undistort", to: "camera/1/undistort/fovea/1", port: "in", type: FR, consumers: 1 },
        { from: "camera/1/undistort/fovea/1", to: RENDERER_ID, port: "in", type: FR, consumers: 0 },
      ],
    };
    const idle = deriveIdle(t);
    expect(idle.nodes.has("camera/1/undistort")).toBe(true);
    expect(idle.nodes.has("camera/1/undistort/fovea/1")).toBe(true);
    expect(idle.nodes.has(RENDERER_ID)).toBe(true);
  });

  it("marks a pipe producer idle from pipe.consumers===0 even with NO consumer edge (production shape)", () => {
    // The orchestrator omits the consumer edge at 0 consumers, so the count
    // rides the node — a parked preview pipe + its camera render idle.
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "camera/1", kind: "camera", output: FR, transport: "native" },
        { id: "camera/1/convert", kind: "convert", output: FR, transport: "pipe", pipe: { consumers: 0, bytesTotal: 0 }, stats: { ratePerSec: 0 } },
      ],
      edges: [{ from: "camera/1", to: "camera/1/convert", port: "in", type: FR }],
    };
    const idle = deriveIdle(t);
    expect(idle.nodes.has("camera/1/convert")).toBe(true);
    expect(idle.nodes.has("camera/1")).toBe(true);
  });

  it("keeps a pipe producer LIVE while pipe.consumers>0 (SHM readers = demand)", () => {
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "camera/1/convert", kind: "convert", output: FR, transport: "pipe", pipe: { consumers: 2, bytesTotal: 9 }, stats: { ratePerSec: 0 } },
      ],
      edges: [],
    };
    expect(deriveIdle(t).nodes.size).toBe(0);
  });

  it("never invents idle for an unmetered stage-1 pipe (no pipe consumer info)", () => {
    // deriveTopology nodes carry no `pipe` field + no downstream edges — demand
    // can't be positively disproven, so nothing renders idle.
    expect(deriveIdle(deriveTopology([], PIPES, 1, 0)).nodes.size).toBe(0);
  });

  it("never invents idle for an unmetered terminal sink (default live)", () => {
    // A recorder sink with an incoming edge that carries NO consumer count —
    // demand can't be disproven, so it stays live.
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "camera/1/convert", kind: "convert", output: FR, transport: "pipe", stats: { ratePerSec: 0 } },
        { id: "recorder/foo", kind: "record", output: null, transport: "sink" },
      ],
      edges: [{ from: "camera/1/convert", to: "recorder/foo", port: "in", type: FR }],
    };
    const idle = deriveIdle(t);
    expect(idle.nodes.size).toBe(0);
    expect(idle.edges.size).toBe(0);
  });

  it("does not hang on feedback cycles and never false-idles a running loop", () => {
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      nodes: [
        { id: "a", kind: "x", output: FR, transport: "pipe", stats: { ratePerSec: 30 } },
        { id: "b", kind: "y", output: FR, transport: "pipe", stats: { ratePerSec: 30 } },
      ],
      edges: [
        { from: "a", to: "b", port: "in", type: FR },
        { from: "b", to: "a", port: "in", type: FR },
      ],
    };
    expect(deriveIdle(t).nodes.size).toBe(0);
  });

  it("toElements labels an idle edge 'idle' and classes idle nodes/edges", () => {
    const els = toElements(chain(0));
    const edge = els.find((e) => e.data.id === `edge:camera/1/convert->${RENDERER_ID}#in`)!;
    expect(edge.data.label).toBe("idle");
    expect(edge.classes).toBe("idle");
    expect(els.find((e) => e.data.id === "camera/1/convert")!.classes).toBe("idle");
  });
});

describe("collapseConsumerSinks — SHM consumer collapse (user 2026-07-10)", () => {
  const sink = (id: string): GraphNode => ({ id, kind: "view", output: null, transport: "sink" });
  const topo = (): GraphTopology => ({
    seq: 1,
    at: 0,
    nodes: [
      { id: "camera/1/convert", kind: "convert", output: FR, transport: "pipe" },
      sink("camera/1/convert/consumers"),
      { id: "camera/2/undistort", kind: "undistort", output: FR, transport: "pipe" },
      sink("camera/2/undistort/consumers"),
      { id: "camera/3/convert", kind: "convert", output: FR, transport: "pipe" },
      sink("camera/3/convert/consumers"),
      { id: "win/scope/kcf", kind: "kcf", output: { kind: "track" }, transport: "native" }, // real consumer
    ],
    edges: [
      { from: "camera/1/convert", to: "camera/1/convert/consumers", port: "in", type: FR, consumers: 1 },
      { from: "camera/2/undistort", to: "camera/2/undistort/consumers", port: "in", type: FR, consumers: 3 },
      { from: "camera/3/convert", to: "camera/3/convert/consumers", port: "in", type: FR, consumers: 1 },
      { from: "camera/3/convert", to: "win/scope/kcf", port: "in", type: FR }, // worker consumer, untouched
    ],
  });

  it("folds N SHM sinks into ONE renderer node with N fan-in edges; real consumers untouched", () => {
    const c = collapseConsumerSinks(topo());
    const ids = c.nodes.map((n) => n.id);
    expect(ids).not.toContain("camera/1/convert/consumers");
    expect(ids.filter((id) => id === RENDERER_ID)).toHaveLength(1);
    expect(ids).toContain("win/scope/kcf"); // real worker consumer survives
    const intoRenderer = c.edges.filter((e) => e.to === RENDERER_ID);
    expect(intoRenderer.map((e) => e.from).sort()).toEqual([
      "camera/1/convert",
      "camera/2/undistort",
      "camera/3/convert",
    ]);
    // the worker edge is NOT redirected
    expect(c.edges.some((e) => e.to === "win/scope/kcf" && e.from === "camera/3/convert")).toBe(true);
  });

  it("folds consumer count into the edge hover detail, one edge per pipe (no parallels)", () => {
    const els = toElements(topo());
    const e2 = els.find((el) => el.data.id === `edge:camera/2/undistort->${RENDERER_ID}#in`)!;
    expect((e2.data.detail as HoverDetail).rows).toContainEqual(["consumers", "×3"]);
    const rendererEdges = els.filter((el) => el.group === "edges" && el.data.target === RENDERER_ID);
    expect(rendererEdges).toHaveLength(3);
  });

  it("is a reference-stable no-op when there are no consumer sinks", () => {
    const d = deriveTopology([], PIPES, 1, 0);
    expect(collapseConsumerSinks(d)).toBe(d); // same ref → membershipKey unchanged
  });
});

describe("hover distance + opacity — distance-graded hover (user 2026-07-10)", () => {
  // camera/123 → convert, camera/123 → undistort (two edges, three nodes).
  const els = toElements(deriveTopology([], PIPES, 1, 0));
  const CONVERT_EDGE = "edge:camera/123->camera/123/convert#in";
  const UNDISTORT_EDGE = "edge:camera/123->camera/123/undistort#in";

  it("from a NODE: 0 at the hovered node, 1 at incident edges, 2 at far endpoints", () => {
    const d = hoverDistances(els, "camera/123");
    expect(d.get("camera/123")).toBe(0);
    expect(d.get(CONVERT_EDGE)).toBe(1);
    expect(d.get(UNDISTORT_EDGE)).toBe(1);
    expect(d.get("camera/123/convert")).toBe(2);
    expect(d.get("camera/123/undistort")).toBe(2);
  });

  it("from an EDGE: its endpoints are distance 1, the sibling branch farther", () => {
    const d = hoverDistances(els, CONVERT_EDGE);
    expect(d.get(CONVERT_EDGE)).toBe(0);
    expect(d.get("camera/123")).toBe(1);
    expect(d.get("camera/123/convert")).toBe(1);
    expect(d.get(UNDISTORT_EDGE)).toBe(2); // camera(1) → undistort edge(2)
  });

  it("unreachable elements are absent from the map, and an unknown hovered id → empty", () => {
    expect(hoverDistances(els, "camera/123").has("ghost")).toBe(false);
    expect(hoverDistances(els, "ghost/node").size).toBe(0);
    expect(hoverDistances([], "camera/123").size).toBe(0);
  });

  it("opacity fades monotonically with distance and clamps to a floor", () => {
    expect(hoverOpacity(0)).toBe(1);
    expect(hoverOpacity(0)).toBeGreaterThan(hoverOpacity(1));
    expect(hoverOpacity(1)).toBeGreaterThan(hoverOpacity(2));
    expect(hoverOpacity(Infinity)).toBe(HOVER_OPACITY_FLOOR);
    expect(hoverOpacity(999)).toBe(HOVER_OPACITY_FLOOR);
  });

  it("composes idle via MIN(idle-resting, hover-opacity)", () => {
    // a near idle element stays capped at the idle resting opacity…
    expect(effectiveOpacity(0, true)).toBe(IDLE_OPACITY);
    expect(effectiveOpacity(0, false)).toBe(1);
    // …and the far graph floors regardless of idle
    expect(effectiveOpacity(Infinity, false)).toBe(HOVER_OPACITY_FLOOR);
    expect(effectiveOpacity(Infinity, true)).toBe(HOVER_OPACITY_FLOOR);
  });
});

describe("nodeLabel — role abbreviations in an app context (user 2026-07-10)", () => {
  const roles = { "111": "L", "222": "C", "333": "R" };
  const n = (id: string): GraphNode => ({ id, kind: "x", output: null, transport: "native" });

  it("labels a leased camera + its middleware by role, no upstream breadcrumb", () => {
    expect(nodeLabel(n("camera/222"), roles)).toBe("C");
    expect(nodeLabel(n("camera/222/convert"), roles)).toBe("C/convert");
    expect(nodeLabel(n("camera/222/undistort"), roles)).toBe("C/undistort");
    expect(nodeLabel(n("camera/222/undistort/kcf"), roles)).toBe("C/kcf");
    expect(nodeLabel(n("camera/222/undistort/fovea/2"), roles)).toBe("C/fovea/2");
    expect(nodeLabel(n("camera/111/convert"), roles)).toBe("L/convert");
    expect(nodeLabel(n("camera/333/undistort"), roles)).toBe("R/undistort");
  });

  it("falls back to the serial tail for unknown serials + the manage-cameras exemption", () => {
    // unknown serial (not leased): keep the serial label, never a wrong role
    expect(nodeLabel(n("camera/999/convert"), roles)).toBe("999/convert");
    // no roles map at all (manage-cameras context)
    expect(nodeLabel(n("camera/222/convert"))).toBe("222/convert");
    expect(nodeLabel(n("camera/222"))).toBe("camera/222");
  });

  it("leaves non-camera nodes on the 2-segment tail regardless of roles", () => {
    expect(nodeLabel(n("win/scope-1/kcf"), roles)).toBe("scope-1/kcf");
    expect(nodeLabel(n(RENDERER_ID), roles)).toBe("renderer");
    expect(nodeLabel(n("controller"), roles)).toBe("controller");
  });

  it("toElements threads GraphTopology.roles into the labels", () => {
    const t: GraphTopology = {
      seq: 1,
      at: 0,
      roles: { "222": "C" },
      nodes: [n("camera/222/undistort/fovea/2")],
      edges: [],
    };
    expect(toElements(t).find((e) => e.data.id === "camera/222/undistort/fovea/2")!.data.label).toBe(
      "C/fovea/2",
    );
  });
});
