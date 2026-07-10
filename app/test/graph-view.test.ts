// A-33 profiler graph panel — the pure view-model layer (`graph-view.ts`):
// Stage-1 topology derivation from mock workload rows + pipe adverts, the
// cytoscape element reduction, and the membership key that gates re-layout.
// This IS the panel's mock-data story: the same mocks drive the component.

import { describe, expect, it } from "vitest";
import {
  deriveTopology,
  edgeDetail,
  edgeLabel,
  edgeWarns,
  focusSet,
  isBackpressured,
  isDropping,
  membershipKey,
  nodeDetail,
  nodeLabel,
  selectTopology,
  toElements,
  type HoverDetail,
} from "@src/profiler/graph-view";
import type { GraphEdge } from "@lib/orchestrator/graph-contract";
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

  it("renders the served shape: consumer sinks, win/ nodes, exact byte-rate edges", () => {
    const els = toElements(served());
    // Consumer sink node renders with a compact 2-segment label.
    const sink = els.find((e) => e.data.id === "camera/123/convert/consumers")!;
    expect(sink.data.label).toBe("convert/consumers");
    // The wired kcf node under win/ carries its saturation class; the
    // metrics moved into the hover card.
    const kcf = els.find((e) => e.data.id === "win/scope-1/kcf")!;
    expect(kcf.classes).toBe("saturated");
    expect(kcf.data.label).toBe("scope-1/kcf");
    expect((kcf.data.detail as HoverDetail).rows).toContainEqual([
      "utilization",
      "95% — SATURATED",
    ]);
    // The consumer edge label shows the effective rate only; the byte rate
    // and consumer refcount live in the hover card.
    const edge = els.find(
      (e) => e.data.id === "edge:camera/123/convert->camera/123/convert/consumers#in",
    )!;
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

describe("focusSet — hover focus dim (user 2026-07-08)", () => {
  // camera/123 → convert, camera/123 → undistort (two edges, three nodes).
  const els = toElements(deriveTopology([], PIPES, 1, 0));
  const CONVERT_EDGE = "edge:camera/123->camera/123/convert#in";
  const UNDISTORT_EDGE = "edge:camera/123->camera/123/undistort#in";

  it("node hover keeps the node, its edges, AND the neighbor nodes", () => {
    // The one-hop neighborhood reads as a unit — far endpoints stay bright so
    // no edge renders as a dangling arrow (documented refinement).
    expect(focusSet(els, "camera/123")).toEqual(
      new Set([
        "camera/123",
        "camera/123/convert",
        "camera/123/undistort",
        CONVERT_EDGE,
        UNDISTORT_EDGE,
      ]),
    );
  });

  it("a leaf node's focus excludes the sibling branch", () => {
    expect(focusSet(els, "camera/123/convert")).toEqual(
      new Set(["camera/123/convert", CONVERT_EDGE, "camera/123"]),
    );
  });

  it("edge hover keeps the edge and its producer + consumer nodes only", () => {
    expect(focusSet(els, CONVERT_EDGE)).toEqual(
      new Set([CONVERT_EDGE, "camera/123", "camera/123/convert"]),
    );
  });

  it("an unknown hovered id (element churned away) yields the EMPTY set", () => {
    expect(focusSet(els, "ghost/node")).toEqual(new Set());
    expect(focusSet([], "camera/123")).toEqual(new Set());
  });
});
