// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// IMM conformance — the TS reference (`app/lib/imm-predictor.ts`) reproduces the
// SHARED vectors in docs/schema/codec/imm-vectors.json (prediction-compose-
// node.md). The native brick (core ImmPredictor.ingest) is pinned to the SAME
// fixture by core/test/42-imm-predictor.ts, so the two implementations agree —
// the 12p-vectors.json precedent, extended to the IMM filter.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ImmPredictor } from "../lib/imm-predictor";

interface ImmFixture {
  config: { delayMs: number };
  tolerancePx: number;
  inputs: Array<{
    found: boolean;
    overridden: boolean;
    center: { x: number; y: number } | null;
    bbox: { x: number; y: number; width: number; height: number } | null;
    seq: number;
    deviceTimestamp: string;
  }>;
  expected: Array<{ found: boolean; center: { x: number; y: number } | null }>;
}

describe("IMM predictor conformance vectors", () => {
  it("pins the TS reference filter to the shared vectors", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../docs/schema/codec/imm-vectors.json"),
        "utf8",
      ),
    ) as ImmFixture;

    const predictor = new ImmPredictor(fixture.config);
    fixture.inputs.forEach((m, i) => {
      const out = predictor.process({
        found: m.found,
        overridden: m.overridden,
        center: m.center,
        bbox: m.bbox,
        seq: m.seq,
        deviceTimestamp: BigInt(m.deviceTimestamp),
      });
      const exp = fixture.expected[i]!;
      expect(out.found, `vector ${i} found`).toBe(exp.found);
      if (exp.center === null) {
        expect(out.center, `vector ${i} center null`).toBeNull();
      } else {
        expect(out.center, `vector ${i} center present`).not.toBeNull();
        expect(out.center!.x, `vector ${i} x`).toBeCloseTo(exp.center.x, 6);
        expect(out.center!.y, `vector ${i} y`).toBeCloseTo(exp.center.y, 6);
      }
    });
  });
});
