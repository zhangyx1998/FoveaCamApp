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
  coastCap: {
    config: { delayMs: number; maxGapMs: number };
    tolerancePx: number;
    warmup: Array<{
      found: boolean;
      overridden: boolean;
      center: { x: number; y: number };
      bbox: { x: number; y: number; width: number; height: number };
      seq: number;
      deviceTimestamp: string;
    }>;
    probes: Array<{
      coastMs: number;
      expected: {
        found: boolean;
        coasting: boolean;
        center: { x: number; y: number } | null;
      };
    }>;
  };
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

  it("pins the R1 coast cap (mirror-flicker 2026-07-12) to the shared vectors", async () => {
    // predictAfter(coastMs): found=true coasting predictions only while
    // coastMs <= maxGapMs; past the cap the miss-coast shape (found=false,
    // coasting=true, center=null) — a stalled source must never extrapolate
    // quadratically forever. Same numbers pinned on the native brick by
    // core/test/42-imm-predictor.ts §6.
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../docs/schema/codec/imm-vectors.json"),
        "utf8",
      ),
    ) as ImmFixture;
    const cc = fixture.coastCap;

    const predictor = new ImmPredictor(cc.config);
    for (const m of cc.warmup)
      predictor.process({
        found: m.found,
        overridden: m.overridden,
        center: m.center,
        bbox: m.bbox,
        seq: m.seq,
        deviceTimestamp: BigInt(m.deviceTimestamp),
      });
    for (const probe of cc.probes) {
      const out = predictor.predictAfter(probe.coastMs);
      expect(out, `coast ${probe.coastMs}ms present`).not.toBeNull();
      expect(out!.found, `coast ${probe.coastMs}ms found`).toBe(probe.expected.found);
      expect(out!.coasting, `coast ${probe.coastMs}ms coasting`).toBe(
        probe.expected.coasting,
      );
      if (probe.expected.center === null) {
        expect(out!.center, `coast ${probe.coastMs}ms center null (capped)`).toBeNull();
      } else {
        expect(out!.center!.x, `coast ${probe.coastMs}ms x`).toBeCloseTo(
          probe.expected.center.x,
          6,
        );
        expect(out!.center!.y, `coast ${probe.coastMs}ms y`).toBeCloseTo(
          probe.expected.center.y,
          6,
        );
      }
    }
    // Cold predictor: no measurement ever → null (never a fabricated pose).
    expect(new ImmPredictor(cc.config).predictAfter(0)).toBeNull();
  });
});
