// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Prediction compose node (prediction-compose-node.md) — the PURE feed-forward
// delta math + the node's rebase/tick/hold semantics.

import { describe, expect, it } from "vitest";
import {
  composeVolts,
  createComposeNode,
  type ComposeVolts,
} from "../orchestrator/compose-node";

const V = (lx: number, ly: number, rx: number, ry: number): ComposeVolts => ({
  l: { x: lx, y: ly },
  r: { x: rx, y: ry },
});

describe("composeVolts (feed-forward delta in volt space)", () => {
  it("adds J·(pred − meas) per eye per axis to the baseline", () => {
    const base = V(1, 2, 3, 4);
    const pred = V(10, 10, 10, 10);
    const meas = V(8, 7, 6, 5);
    // baseline + (pred − meas)
    expect(composeVolts(base, pred, meas)).toEqual(
      V(1 + 2, 2 + 3, 3 + 4, 4 + 5),
    );
  });

  it("holds the baseline when there is no feed-forward (pred or meas null)", () => {
    const base = V(1, 2, 3, 4);
    expect(composeVolts(base, null, V(0, 0, 0, 0))).toEqual(base);
    expect(composeVolts(base, V(9, 9, 9, 9), null)).toEqual(base);
    expect(composeVolts(base, null, null)).toEqual(base);
  });

  it("is a no-op feed-forward when pred == meas (target hasn't moved)", () => {
    const base = V(5, 5, 5, 5);
    const same = V(2, 2, 2, 2);
    expect(composeVolts(base, same, same)).toEqual(base);
  });
});

describe("createComposeNode", () => {
  it("rebases the baseline and applies / holds the feed-forward on tick", () => {
    const node = createComposeNode({
      id: "win/test/compose",
      pidId: "win/test/pid",
      immId: "camera/1/undistort/kcf/imm",
      controllerId: "controller",
      initial: V(0, 0, 0, 0),
    });
    try {
      // Rebase from a pid result at measured operating point follow(p_meas).
      node.rebase(V(100, 100, 200, 200), V(50, 50, 60, 60));
      expect(node.baseline).toEqual(V(100, 100, 200, 200));

      // A healthy tick with a prediction volt applies the delta.
      expect(node.tick(V(55, 52, 66, 61))).toEqual(
        V(100 + 5, 100 + 2, 200 + 6, 200 + 1),
      );

      // An unhealthy / coasted-miss tick (null pred) holds the baseline.
      expect(node.tick(null)).toEqual(V(100, 100, 200, 200));

      // A fresh rebase with no measured volts (no calibration) → hold baseline.
      node.rebase(V(7, 7, 7, 7), null);
      expect(node.tick(V(99, 99, 99, 99))).toEqual(V(7, 7, 7, 7));

      // report() carries both incoming edges (pid + imm).
      const r = node.report();
      expect(r.kind).toBe("compose");
      expect(r.inputs.map((i) => i.from).sort()).toEqual(
        ["camera/1/undistort/kcf/imm", "win/test/pid"].sort(),
      );
    } finally {
      node.dispose();
    }
  });
});
