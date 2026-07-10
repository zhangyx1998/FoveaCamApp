// IMM predictor NODE wiring (docs/proposals/imm-delay-compensation.md): the
// graph-visible wrapper around the pure `@lib/imm-predictor` that registers the
// `tracker → imm` edge + self-meters one unit per prediction, so the LR graph
// reads kcf → imm → pid with truthful edge rates. Pure — no native addon.

import { describe, expect, it, beforeEach } from "vitest";
import { createImmNode } from "@orchestrator/imm-node";
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";
import type { TrackResult } from "core/Tracker";

const KCF = "camera/S1/undistort/kcf";
const IMM = "camera/S1/undistort/kcf/imm";

function makeNode(delayMs = 20) {
  return createImmNode({
    id: IMM,
    owner: "win/disparity-scope",
    trackerId: KCF,
    port: "target",
    config: { delayMs },
  });
}

function res(seq: number, x: number): TrackResult {
  return {
    found: true,
    overridden: false,
    center: { x, y: 0 },
    bbox: { x: x - 5, y: -5, width: 10, height: 10 },
    seq,
    deviceTimestamp: BigInt(seq) * 16_666_666n,
  };
}

describe("createImmNode — graph wiring", () => {
  beforeEach(resetTopologyStateForTest);

  it("report() carries the imm identity + the tracker → imm incoming edge", () => {
    const node = makeNode();
    expect(node.report()).toMatchObject({
      id: IMM,
      kind: "imm",
      transport: "native",
      owner: "win/disparity-scope",
      output: { kind: "track" },
      inputs: [{ from: KCF, port: "target", type: { kind: "track" } }],
    });
    node.dispose();
  });

  it("registers the imm node + the kcf → imm edge in the topology", () => {
    const node = makeNode();
    const topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
    expect(topo.nodes.find((n) => n.id === IMM)).toMatchObject({
      kind: "imm",
      owner: "win/disparity-scope",
      transport: "native",
    });
    expect(topo.edges).toContainEqual(
      expect.objectContaining({ from: KCF, to: IMM, port: "target" }),
    );
    node.dispose();
  });

  it("dispose() retires the wiring — the node disappears", () => {
    const node = makeNode();
    node.dispose();
    const topo = buildTopology({
      listPipes: () => [],
      workloads: () => ({}),
      now: () => 0,
    });
    expect(topo.nodes.find((n) => n.id === IMM)).toBeUndefined();
  });
});

describe("createImmNode — process forwards through the predictor", () => {
  beforeEach(resetTopologyStateForTest);

  it("passes the first result through, then rewrites the center on a CV track", () => {
    const node = makeNode(30);
    const first = res(0, 0);
    expect(node.process(first)).toBe(first); // cold → passthrough
    let out!: TrackResult;
    for (let i = 1; i <= 30; i++) out = node.process(res(i, i * 5)); // v ≈ const
    // A positive delay leads the measurement (predicted center runs ahead).
    expect(out.center!.x).toBeGreaterThan(30 * 5);
    node.dispose();
  });
});
