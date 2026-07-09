// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// pairing-nodes P-1: the per-stage L/R PAIRING brick (`createPairStream`). Two
// in-process FIFO taps joined against FIN-derived anchors. NO hardware — two
// SYNTHETIC ConvertedFrame producers (`createPairTestSource` / `pushPairTestFrame`)
// feed the brick frames with EXPLICIT deviceTimestamps (the fake camera can't
// control those), and `pushAnchor` supplies the anchors.
//
// Proves:
//   1. ROOT tolerance match — anchor + in-tolerance L/R complete a pair record
//      (anchor id/tExposure/stream + opaque payload round-trip + L/R frame
//      identity), delivered on the batched async iterator.
//   2. ROOT miss — an anchor far from the frames never produces a pair.
//   3. ROOT late frame — anchor + L present, R arrives LATE and still completes.
//   4. EXACT join — L/R with IDENTICAL deviceTimestamps + an anchor with that
//      key join; a frame with no anchor for its key ages out (no pair).
//   5. Pool bounds — anchors past `anchorCap` and pending frames past
//      `pendingCap` drop-oldest, observable as probe drop counters.
//   6. Zero-subscriber — with NO iterator attached the brick still consumes
//      inputs, forms the pair, and drops it immediately (pairsProduced > 0).
//   7. Topology — a kind "pair" row with left/right/anchor input edges.
//   8. Clean release (join the brick thread) → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/33-pair-pipe.ts

import assert from "node:assert/strict";
import { Aravis, Topology } from "core";

const A = Aravis as unknown as {
  createPairStream(
    leftId: string,
    rightId: string,
    opts: Record<string, unknown>,
  ): PairObj;
  createPairTestSource(id: string): boolean;
  pushPairTestFrame(
    id: string,
    frame: { deviceTimestamp: bigint; width?: number; height?: number; originX?: number; originY?: number },
  ): boolean;
  releasePairTestSource(id: string): boolean;
};
const T = Topology as unknown as {
  report(): Array<{ id: string; kind: string; inputs: Array<{ from: string; port: string }> }>;
};

interface FrameId {
  deviceTimestamp: bigint;
  width: number;
  height: number;
  originX: number;
  originY: number;
  seq: number;
}
interface Rec {
  anchorId: number;
  tExposure: bigint;
  stream: number;
  payload: Float64Array;
  left: FrameId;
  right: FrameId;
}
interface Batch {
  records: Rec[];
}
interface PairObj {
  pushAnchor(a: { tExposure: bigint; stream?: number; payload?: Float64Array }): number;
  probe(): {
    outputs: { pair: { count: number } };
    inputs: { left: { count: number }; right: { count: number } };
    anchorDrops: number;
    leftDrops: number;
    rightDrops: number;
    completedDrops: number;
    pairsProduced: number;
    anchorPoolSize: number;
    mode: string;
  };
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Batch>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Race it.next() against a deadline. Returns the batch, or null on timeout.
async function nextBatch(it: AsyncIterator<Batch>, ms: number): Promise<Batch | null> {
  return Promise.race([
    it.next().then((r) => (r.done ? null : r.value)),
    sleep(ms).then(() => null),
  ]);
}

let srcN = 0;
function makePair(mode: "root" | "exact", opts: Record<string, unknown> = {}): {
  pair: PairObj;
  L: string;
  R: string;
  stage: string;
} {
  const L = `test/pair/src/${srcN}/L`;
  const R = `test/pair/src/${srcN}/R`;
  const stage = `pair/test-${srcN}`;
  srcN++;
  assert.equal(A.createPairTestSource(L), true, "L test source created");
  assert.equal(A.createPairTestSource(R), true, "R test source created");
  const pair = A.createPairStream(L, R, { mode, stage, toleranceNs: 5_000_000n, ...opts });
  return { pair, L, R, stage };
}
function teardown(pair: PairObj, L: string, R: string): void {
  pair.release();
  A.releasePairTestSource(L);
  A.releasePairTestSource(R);
}

// --- 1: ROOT tolerance match (hit) -------------------------------------------
{
  const { pair, L, R } = makePair("root");
  const it = pair[Symbol.asyncIterator]();
  const tExp = 1_000_000_000n;
  pair.pushAnchor({ tExposure: tExp, stream: 3, payload: new Float64Array([1.5, 2.5, 3.5]) });
  A.pushPairTestFrame(L, { deviceTimestamp: tExp, width: 16, height: 12, originX: 4, originY: 8 });
  A.pushPairTestFrame(R, { deviceTimestamp: tExp + 2_000_000n, width: 16, height: 12 }); // +2 ms, in-tol

  const batch = await nextBatch(it, 3000);
  assert(batch && batch.records.length >= 1, "a pair record arrived on the iterator");
  const rec = batch.records[0]!;
  assert.equal(rec.stream, 3, "record carries the FIN stream id");
  assert.equal(rec.tExposure, tExp, "record carries the anchor tExposure");
  assert(rec.anchorId >= 1, "record carries a brick-assigned anchorId");
  assert.deepEqual(Array.from(rec.payload), [1.5, 2.5, 3.5], "opaque payload round-trips");
  assert.equal(rec.left.deviceTimestamp, tExp, "left frame identity (deviceTimestamp)");
  assert.equal(rec.right.deviceTimestamp, tExp + 2_000_000n, "right frame identity");
  assert.equal(rec.left.originX, 4, "left origin forwarded");
  assert.equal(rec.left.width, 16, "left width forwarded");
  assert.equal(pair.probe().pairsProduced, 1, "meter counts one produced pair");
  console.log("33-pair: ROOT tolerance match (hit) + record round-trip OK.");
  await it.return?.();
  teardown(pair, L, R);
}

// --- 2: ROOT miss ------------------------------------------------------------
{
  const { pair, L, R } = makePair("root");
  // Anchor far from the frames → never matches.
  pair.pushAnchor({ tExposure: 5_000_000_000n, stream: 0 });
  A.pushPairTestFrame(L, { deviceTimestamp: 1_000_000_000n });
  A.pushPairTestFrame(R, { deviceTimestamp: 1_001_000_000n });
  await sleep(300);
  assert.equal(pair.probe().pairsProduced, 0, "no pair when the anchor is out of tolerance");
  console.log("33-pair: ROOT miss (out-of-tolerance anchor) OK.");
  teardown(pair, L, R);
}

// --- 3: ROOT late frame ------------------------------------------------------
{
  const { pair, L, R } = makePair("root");
  const it = pair[Symbol.asyncIterator]();
  const tExp = 2_000_000_000n;
  pair.pushAnchor({ tExposure: tExp, stream: 1 });
  A.pushPairTestFrame(L, { deviceTimestamp: tExp }); // L present, R missing
  await sleep(200);
  assert.equal(pair.probe().pairsProduced, 0, "no pair while R is missing");
  A.pushPairTestFrame(R, { deviceTimestamp: tExp + 1_000_000n }); // late R, in-tol
  const batch = await nextBatch(it, 3000);
  assert(batch && batch.records.length >= 1, "the late R completes the pair");
  console.log("33-pair: ROOT late-frame join OK.");
  await it.return?.();
  teardown(pair, L, R);
}

// --- 4: EXACT join -----------------------------------------------------------
{
  const { pair, L, R } = makePair("exact");
  const it = pair[Symbol.asyncIterator]();
  assert.equal(pair.probe().mode, "exact", "brick reports exact mode");
  const key = 3_000_000_000n;
  // A frame whose key has NO anchor → ages out (no pair).
  A.pushPairTestFrame(L, { deviceTimestamp: 9_999_000_000n });
  A.pushPairTestFrame(R, { deviceTimestamp: 9_999_000_000n });
  await sleep(150);
  assert.equal(pair.probe().pairsProduced, 0, "anchor-less identical frames do NOT pair (exact)");
  // Now the keyed anchor + identical-timestamp L/R.
  pair.pushAnchor({ tExposure: key, stream: 2 });
  A.pushPairTestFrame(L, { deviceTimestamp: key });
  A.pushPairTestFrame(R, { deviceTimestamp: key });
  const batch = await nextBatch(it, 3000);
  assert(batch && batch.records.length >= 1, "exact-key L/R + anchor join");
  assert.equal(batch.records[0]!.left.deviceTimestamp, key, "exact join on the shared key");
  console.log("33-pair: EXACT key join (+ anchor-less age-out) OK.");
  await it.return?.();
  teardown(pair, L, R);
}

// --- 5: pool bounds (drop-oldest observable in the meter) --------------------
{
  const { pair, L, R } = makePair("root", { anchorCap: 4, pendingCap: 4 });
  // 10 anchors, no matching frames → 6 drop-oldest, pool capped at 4.
  for (let i = 0; i < 10; i++) pair.pushAnchor({ tExposure: BigInt(10_000 + i), stream: 0 });
  let p = pair.probe();
  assert.equal(p.anchorPoolSize, 4, "anchor pool capped at anchorCap");
  assert.equal(p.anchorDrops, 6, "6 oldest anchors dropped");
  // 10 left frames, no matching anchor → 6 drop-oldest on the left pending pool.
  for (let i = 0; i < 10; i++) A.pushPairTestFrame(L, { deviceTimestamp: BigInt(500_000_000 + i) });
  await sleep(300);
  p = pair.probe();
  assert(p.leftDrops >= 6, `left pending drop-oldest observable (leftDrops=${p.leftDrops})`);
  assert(p.inputs.left.count >= 10, "left ingest metered");
  console.log("33-pair: pool bounds (anchor + pending drop-oldest) OK.");
  teardown(pair, L, R);
}

// --- 6: zero-subscriber drop -------------------------------------------------
{
  const { pair, L, R } = makePair("root");
  // NO iterator attached. The brick must still consume + form + drop the pair.
  const tExp = 4_000_000_000n;
  pair.pushAnchor({ tExposure: tExp, stream: 0 });
  A.pushPairTestFrame(L, { deviceTimestamp: tExp });
  A.pushPairTestFrame(R, { deviceTimestamp: tExp + 1_000_000n });
  await sleep(300);
  const p = pair.probe();
  assert(p.pairsProduced >= 1, "pair formed with zero subscribers");
  assert.equal(p.anchorPoolSize, 0, "the matched anchor was consumed (not leaked)");
  console.log("33-pair: zero-subscriber consume+drop OK.");
  teardown(pair, L, R);
}

// --- 7: topology row ---------------------------------------------------------
{
  const { pair, L, R, stage } = makePair("root", { anchorFrom: "controller/anchors" });
  const row = T.report().find((n) => n.id === stage);
  assert(row, "pairing brick appears in Topology.report()");
  assert.equal(row!.kind, "pair", "topology kind == pair");
  assert(row!.inputs.some((i) => i.from === L && i.port === "left"), "left input edge");
  assert(row!.inputs.some((i) => i.from === R && i.port === "right"), "right input edge");
  assert(
    row!.inputs.some((i) => i.from === "controller/anchors" && i.port === "anchor"),
    "anchor input edge from the enrichment node",
  );
  console.log("33-pair: topology row (kind pair, left/right/anchor edges) OK.");
  teardown(pair, L, R);
}

// --- 8: clean release already exercised per-section --------------------------
await sleep(100);
console.log("33-pair-pipe: orderly teardown complete — exiting naturally.");
