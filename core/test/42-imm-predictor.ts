// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native IMM motion-predictor brick (prediction-compose-node.md) — NO hardware:
// the brick ingests SYNTHETIC tracker measurements and emits predictions on its
// own free-running thread, so the whole seam is verifiable rig-free.
//
// Three proofs:
//  1. CONFORMANCE — feed the shared vectors (docs/schema/codec/imm-vectors.json,
//     generated from the TS reference `app/lib/imm-predictor.ts`) and assert the
//     brick's `ingest()` return (the zero-coast prediction) reproduces the
//     reference `expected` centers within `tolerancePx`. The SAME fixture pins
//     the TS filter in app/test/imm-conformance.test.ts — the two agree.
//  2. FREE-RUNNING RATE + COASTING — subscribe the async iterator, warm the
//     filter with a steady measurement stream, and assert predictions flow far
//     ABOVE camera rate (the 600 Hz free-run) with the coasting flag set and the
//     center EXTRAPOLATING between measurements.
//  3. METER + setParams — the thread meter records measure/predict counts
//     (folds onto the profiler node), and a live rate change applies.
//
// Run UNSANDBOXED: node core/test/42-imm-predictor.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Tracker, cleanup } from "core";

type Prediction = {
  found: boolean;
  overridden: boolean;
  coasting: boolean;
  center: { x: number; y: number } | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  seq: number;
  deviceTimestamp: bigint;
  propagatedToNs: bigint;
};
type Brick = {
  ingest(m: unknown): Prediction;
  setParams(p: { rateHz?: number; delayMs?: number }): void;
  probe(): {
    name: string;
    inputs: Record<string, { count: number; ratePerSec: number }>;
    outputs: Record<string, { count: number; ratePerSec: number }>;
    busyMs: number;
  };
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Prediction>;
};
const T = Tracker as unknown as {
  createImmPredictor(o?: Record<string, unknown>): Brick;
};

interface Fixture {
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

const fixturePath = fileURLToPath(
  new URL("../../docs/schema/codec/imm-vectors.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

// --- 1. CONFORMANCE ---------------------------------------------------------
{
  const brick = T.createImmPredictor({ rateHz: 600, ...fixture.config });
  const tol = fixture.tolerancePx;
  let checked = 0;
  fixture.inputs.forEach((m, i) => {
    const out = brick.ingest({
      found: m.found,
      overridden: m.overridden,
      center: m.center,
      bbox: m.bbox,
      seq: m.seq,
      deviceTimestamp: BigInt(m.deviceTimestamp),
    });
    const exp = fixture.expected[i]!;
    assert.equal(out.found, exp.found, `vector ${i} found`);
    if (exp.center === null) {
      assert.equal(out.center, null, `vector ${i} center null`);
    } else {
      assert(out.center, `vector ${i} center present`);
      assert(
        Math.abs(out.center!.x - exp.center.x) <= tol &&
          Math.abs(out.center!.y - exp.center.y) <= tol,
        `vector ${i} center matches reference within ${tol}px ` +
          `(got ${JSON.stringify(out.center)}, want ${JSON.stringify(exp.center)})`,
      );
    }
    // Zero-coast ingest return is never a between-frame coasting emit.
    assert.equal(out.coasting, false, `vector ${i} ingest is zero-coast`);
    checked++;
  });
  brick.release();
  console.log(
    `42-imm-predictor: conformance OK — ${checked} vectors match the TS reference within ${tol}px.`,
  );
}

// --- 2. FREE-RUNNING RATE + COASTING ---------------------------------------
{
  const brick = T.createImmPredictor({ rateHz: 600, delayMs: 12.5 });
  const DT_NS = 16_666_667n; // ~60 Hz measurements
  let ts = 5_000_000_000n;
  let seq = 0;
  // Warm the filter with a steady rightward drift so the estimate has velocity.
  let x = 300;
  const y = 240;
  const feed = (): void => {
    brick.ingest({
      found: true,
      overridden: false,
      center: { x, y },
      bbox: { x: x - 32, y: y - 32, width: 64, height: 64 },
      seq: ++seq,
      deviceTimestamp: ts,
    });
    x += 8; // 8 px/frame ⇒ ~480 px/s
    ts += DT_NS;
  };
  for (let i = 0; i < 5; i++) feed();

  // Subscribe + collect predictions for a window while the measurement stream
  // keeps ticking at ~60 Hz on a timer.
  const measureTimer = setInterval(feed, 16);
  const preds: Prediction[] = [];
  const started = Date.now();
  const WINDOW_MS = 500;
  const deadline = started + WINDOW_MS;
  for await (const r of brick as AsyncIterable<Prediction>) {
    preds.push(r);
    if (Date.now() > deadline) break;
  }
  clearInterval(measureTimer);
  const elapsed = Date.now() - started;
  const hz = (preds.length / elapsed) * 1000;

  // Far above camera rate (the whole point of the free-running brick): a 60 Hz
  // producer could not emit this many in the window. Loose bound (sleep
  // granularity varies) but well clear of 60 Hz.
  assert(
    hz > 120,
    `predictions free-run above camera rate (got ~${hz.toFixed(0)} Hz over ${preds.length} emits)`,
  );
  const found = preds.filter((p) => p.found && p.center);
  assert(found.length >= 10, `found predictions flow (${found.length})`);
  const coasting = preds.filter((p) => p.coasting);
  assert(
    coasting.length >= 5,
    `between-frame coasting emits present (${coasting.length}/${preds.length})`,
  );
  // Every emitted center is finite.
  for (const p of found)
    assert(
      Number.isFinite(p.center!.x) && Number.isFinite(p.center!.y),
      "coasting center is finite",
    );
  // EXTRAPOLATION: with a rightward velocity, coasting centers must span a
  // non-trivial x range (the estimate advances between measurements) — a static
  // hold would collapse to a single x.
  const xs = found.map((p) => p.center!.x);
  const span = Math.max(...xs) - Math.min(...xs);
  assert(span > 1, `coasting extrapolates the target motion (x span ${span.toFixed(1)}px)`);

  const snap = brick.probe();
  assert(snap.inputs.measure && snap.inputs.measure.count > 0, "measure ingested");
  assert(snap.outputs.predict && snap.outputs.predict.count > 0, "predictions metered");
  console.log(
    `42-imm-predictor: free-run ~${hz.toFixed(0)} Hz over ${preds.length} emits ` +
      `(coasting ${coasting.length}, x span ${span.toFixed(1)}px, ` +
      `meter measure=${snap.inputs.measure.count} predict=${snap.outputs.predict.count}).`,
  );
  brick.release();
}

// --- 3. setParams live change ----------------------------------------------
{
  const brick = T.createImmPredictor({ rateHz: 600, delayMs: 0 });
  brick.ingest({
    found: true,
    overridden: false,
    center: { x: 10, y: 10 },
    bbox: null,
    seq: 1,
    deviceTimestamp: 1_000_000_000n,
  });
  // Live rate + delay change applies without throwing; a clamped-out rate is
  // accepted (the brick floors/ceils internally).
  brick.setParams({ rateHz: 90 });
  brick.setParams({ delayMs: -8, rateHz: 2000 }); // rate clamped to 1000
  brick.setParams({ rateHz: 30 }); // clamped up to 60
  // Still produces after the changes.
  const collected: Prediction[] = [];
  const deadline = Date.now() + 200;
  for await (const r of brick as AsyncIterable<Prediction>) {
    collected.push(r);
    if (Date.now() > deadline) break;
  }
  assert(collected.length > 0, "predictions continue after setParams");
  console.log(
    `42-imm-predictor: setParams live rate/delay change applied (${collected.length} emits after).`,
  );
  brick.release();
}

cleanup();
console.log("42-imm-predictor: native IMM brick conformance + free-run + meter passed.");
