// Anchor enrichment node coverage (pairing-nodes ruling 4). Concerns:
//   (1) PAYLOAD PACKING — a FIN outcome's exposure-averaged volts → V2A angles →
//       per-side H, packed into the opaque doubles payload at the ruled offsets
//       (a fake calibration makes the arithmetic checkable); volts-only when no
//       conversions are wired.
//   (2) FAN-OUT — N registered pairing sinks each receive the SAME anchor
//       (tExposure/stream/payload); an unregistered sink stops receiving.
//   (3) GRAPH ROW — the enrichment registers a `controller/anchors` node.
//
// No addon: the pairing bricks are injected `PairAnchorSink` fakes and the
// volts→angle→H math is an injected fake CoordinateConversions subset.

import { afterEach, describe, expect, it } from "vitest";
import {
  AnchorNode,
  anchorNodeId,
  packAnchorPayload,
  ANCHOR_PAYLOAD,
  resetAnchorNodeForTest,
  resolvedAnchorFromRecord,
  type AnchorConversions,
  type PairAnchorSink,
  type PairRecordKeys,
} from "@orchestrator/anchor-node";
import {
  buildTopology,
  resetTopologyStateForTest,
} from "@orchestrator/graph-topology";
import type { FrameOutcome } from "@orchestrator/controller";

type Pos = { x: number; y: number };
const P = (x: number, y: number): Pos => ({ x, y });

function outcome(tExposure: bigint, left: Pos, right: Pos, stream = 0): FrameOutcome {
  return { frameId: 7, stream, tTrigger: tExposure - 100n, tExposure, left, right };
}

// Fake conversions: distinguishable, invertible-by-eye arithmetic.
const fakeConv: AnchorConversions = {
  V2A: {
    L: (v: Pos) => ({ x: v.x * 10, y: v.y * 10 }),
    R: (v: Pos) => ({ x: v.x + 1, y: v.y + 1 }),
  } as never,
  A2H: {
    L: (a: Pos) => new Float64Array([1, 0, a.x, 0, 1, a.y, 0, 0, 1]) as never,
    R: (a: Pos) => new Float64Array([2, 0, a.x, 0, 2, a.y, 0, 0, 1]) as never,
  } as never,
};

/** A fake pairing brick recording pushed anchors. */
function fakeSink(): PairAnchorSink & { anchors: Array<{ tExposure: bigint; stream: number; payload?: Float64Array }> } {
  const anchors: Array<{ tExposure: bigint; stream: number; payload?: Float64Array }> = [];
  return {
    anchors,
    pushAnchor(a) {
      anchors.push(a);
      return anchors.length;
    },
  };
}

let node: AnchorNode | undefined;
afterEach(() => {
  node?.dispose();
  node = undefined;
  resetAnchorNodeForTest();
  resetTopologyStateForTest();
});

describe("packAnchorPayload", () => {
  it("packs volts only when no conversions are wired", () => {
    const p = packAnchorPayload(outcome(0n, P(1, 2), P(3, 4)));
    expect(p.length).toBe(ANCHOR_PAYLOAD.LEN_VOLTS_ONLY);
    expect(Array.from(p)).toEqual([1, 2, 3, 4]);
  });

  it("packs volts + V2A angles + per-side H at the ruled offsets", () => {
    const p = packAnchorPayload(outcome(0n, P(1, 2), P(3, 4)), fakeConv);
    expect(p.length).toBe(ANCHOR_PAYLOAD.LEN_FULL);
    // volts
    expect(Array.from(p.subarray(ANCHOR_PAYLOAD.VOLTS, ANCHOR_PAYLOAD.VOLTS + 4))).toEqual([1, 2, 3, 4]);
    // V2A angles: L = (10,20), R = (4,5)
    expect(Array.from(p.subarray(ANCHOR_PAYLOAD.ANGLES, ANCHOR_PAYLOAD.ANGLES + 4))).toEqual([10, 20, 4, 5]);
    // H_L carries angle L in the translation column
    expect(Array.from(p.subarray(ANCHOR_PAYLOAD.H_LEFT, ANCHOR_PAYLOAD.H_LEFT + 9))).toEqual([1, 0, 10, 0, 1, 20, 0, 0, 1]);
    // H_R carries angle R
    expect(Array.from(p.subarray(ANCHOR_PAYLOAD.H_RIGHT, ANCHOR_PAYLOAD.H_RIGHT + 9))).toEqual([2, 0, 4, 0, 2, 5, 0, 0, 1]);
  });
});

describe("AnchorNode — fan-out", () => {
  it("pushes ONE enriched anchor to every registered sink", () => {
    node = new AnchorNode({ conversions: fakeConv });
    const a = fakeSink();
    const b = fakeSink();
    node.register(a);
    node.register(b);
    expect(node.sinkCount).toBe(2);

    node.ingest(outcome(1_234n, P(1, 2), P(3, 4), 5));

    for (const s of [a, b]) {
      expect(s.anchors.length).toBe(1);
      expect(s.anchors[0]!.tExposure).toBe(1_234n);
      expect(s.anchors[0]!.stream).toBe(5);
      expect(s.anchors[0]!.payload!.length).toBe(ANCHOR_PAYLOAD.LEN_FULL);
      expect(s.anchors[0]!.payload![ANCHOR_PAYLOAD.VOLTS]).toBe(1);
    }
  });

  it("stops delivering to an unregistered sink", () => {
    node = new AnchorNode();
    const a = fakeSink();
    const off = node.register(a);
    node.ingest(outcome(1n, P(0, 0), P(0, 0)));
    off();
    node.ingest(outcome(2n, P(0, 0), P(0, 0)));
    expect(a.anchors.map((x) => x.tExposure)).toEqual([1n]);
  });

  it("volts-only payload when conversions are cleared", () => {
    node = new AnchorNode({ conversions: fakeConv });
    const a = fakeSink();
    node.register(a);
    node.setConversions(undefined);
    node.ingest(outcome(9n, P(1, 2), P(3, 4)));
    expect(a.anchors[0]!.payload!.length).toBe(ANCHOR_PAYLOAD.LEN_VOLTS_ONLY);
  });
});

describe("AnchorNode — graph row", () => {
  it("registers a controller/anchors node", () => {
    node = new AnchorNode();
    const topo = buildTopology({ listPipes: () => [], workloads: () => ({}), now: () => 0 });
    expect(topo.nodes.find((n) => n.id === anchorNodeId())).toBeTruthy();
    expect(anchorNodeId()).toBe("controller/anchors");
  });
});

// (4) RESOLVED-ANCHOR key delivery (pairing-nodes ruling 2, R-1). The root pair
// record's per-side deviceTimestamps become the downstream exact-join keys —
// carried, never re-stamped (trusted-time).
describe("resolvedAnchorFromRecord — root → downstream key delivery", () => {
  it("maps a root pair record to the next stage's per-side join keys", () => {
    const rec: PairRecordKeys = {
      anchorId: 42,
      tExposure: 1_000_000_000n,
      stream: 3,
      payload: new Float64Array([1.5, 2.5]),
      left: { deviceTimestamp: 1_000_000_000n },
      right: { deviceTimestamp: 1_000_222_000n }, // per-side keys differ
    };
    const resolved = resolvedAnchorFromRecord(rec);
    expect(resolved.leftKey).toBe(rec.left.deviceTimestamp);
    expect(resolved.rightKey).toBe(rec.right.deviceTimestamp);
    expect(resolved.anchorId).toBe(42); // origin provenance preserved
    expect(resolved.tExposure).toBe(rec.tExposure);
    expect(resolved.stream).toBe(3);
    expect(Array.from(resolved.payload!)).toEqual([1.5, 2.5]);
  });
});
