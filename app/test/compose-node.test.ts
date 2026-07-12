// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Prediction compose node (prediction-compose-node.md) — the PURE feed-forward
// delta math + the node's rebase/tick/hold semantics.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { composeVolts, type ComposeVolts } from "../orchestrator/compose-node";

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

describe("compose conformance vectors (native brick reference)", () => {
  it("pins composeVolts to the shared vectors the native ComposeStream must match", async () => {
    interface Fixture {
      tolerance: number;
      vectors: Array<{
        seq: number;
        rebase: {
          vPid: { l: { x: number; y: number }; r: { x: number; y: number } };
          pMeas: { x: number; y: number };
          jL: number[];
          jR: number[];
          feedForward: boolean;
        };
        pred: { found: boolean; center: { x: number; y: number } | null };
        expected: { l: { x: number; y: number }; r: { x: number; y: number } };
      }>;
    }
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../docs/schema/codec/compose-vectors.json"),
        "utf8",
      ),
    ) as Fixture;
    const lin = (j: number[], p: { x: number; y: number }) => ({
      x: j[0]! * p.x + j[1]! * p.y,
      y: j[2]! * p.x + j[3]! * p.y,
    });
    for (const v of fixture.vectors) {
      const { rebase, pred, expected } = v;
      const out =
        rebase.feedForward && pred.found && pred.center
          ? composeVolts(
              rebase.vPid,
              { l: lin(rebase.jL, pred.center), r: lin(rebase.jR, pred.center) },
              { l: lin(rebase.jL, rebase.pMeas), r: lin(rebase.jR, rebase.pMeas) },
            )
          : composeVolts(rebase.vPid, null, null);
      expect(out.l.x, `vector ${v.seq} l.x`).toBeCloseTo(expected.l.x, 9);
      expect(out.l.y, `vector ${v.seq} l.y`).toBeCloseTo(expected.l.y, 9);
      expect(out.r.x, `vector ${v.seq} r.x`).toBeCloseTo(expected.r.x, 9);
      expect(out.r.y, `vector ${v.seq} r.y`).toBeCloseTo(expected.r.y, 9);
    }
  });

  it("pins the HIL D2 floor policy sequence (rebase between predictions: NO dip)", async () => {
    // mirror-flicker 2026-07-12 refinement 2: the shared floorPolicy vector.
    // The native brick (core/test/45) runs the sequence through the REAL
    // ComposeStream; here every step's expected emission is recomputed from
    // the composeVolts algebra with the SAME cached-latest-prediction policy:
    // a floor tick applies the newest prediction against the NEW
    // linearization; cold or feedForward=false floors the raw baseline.
    interface Step {
      op: "rebase" | "pred";
      note: string;
      rebase?: {
        vPid: ComposeVolts;
        pMeas?: { x: number; y: number };
        jL?: number[];
        jR?: number[];
        feedForward: boolean;
      };
      pred?: { found: boolean; center: { x: number; y: number } | null };
      expected: ComposeVolts;
    }
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../docs/schema/codec/compose-vectors.json"),
        "utf8",
      ),
    ) as { floorPolicy: { tolerance: number; steps: Step[] } };
    const lin = (j: number[], p: { x: number; y: number }) => ({
      x: j[0]! * p.x + j[1]! * p.y,
      y: j[2]! * p.x + j[3]! * p.y,
    });

    let rebase: NonNullable<Step["rebase"]> | null = null;
    let lastPred: { x: number; y: number } | null = null;
    for (const [i, step] of fixture.floorPolicy.steps.entries()) {
      if (step.op === "rebase") rebase = step.rebase!;
      else lastPred = step.pred!.found ? step.pred!.center : null;
      expect(rebase, `step ${i} has a linearization`).not.toBeNull();
      const r = rebase!;
      const usable = r.feedForward && lastPred && r.pMeas && r.jL && r.jR;
      const out = usable
        ? composeVolts(
            r.vPid,
            { l: lin(r.jL!, lastPred!), r: lin(r.jR!, lastPred!) },
            { l: lin(r.jL!, r.pMeas!), r: lin(r.jR!, r.pMeas!) },
          )
        : composeVolts(r.vPid, null, null);
      expect(out.l.x, `step ${i} l.x (${step.note})`).toBeCloseTo(step.expected.l.x, 9);
      expect(out.l.y, `step ${i} l.y`).toBeCloseTo(step.expected.l.y, 9);
      expect(out.r.x, `step ${i} r.x`).toBeCloseTo(step.expected.r.x, 9);
      expect(out.r.y, `step ${i} r.y`).toBeCloseTo(step.expected.r.y, 9);
    }
  });
});
