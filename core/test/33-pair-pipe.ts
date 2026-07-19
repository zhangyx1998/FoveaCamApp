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
  pushResolvedAnchor(a: {
    anchorId?: number;
    tExposure?: bigint;
    stream?: number;
    leftKey: bigint;
    rightKey: bigint;
    payload?: Float64Array;
  }): number;
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

// --- 4: EXACT join on RESOLVED per-side keys ---------------------------------
{
  const { pair, L, R } = makePair("exact");
  const it = pair[Symbol.asyncIterator]();
  assert.equal(pair.probe().mode, "exact", "brick reports exact mode");
  // Exact mode joins on the RESOLVED per-side keys (leftKey/rightKey), which
  // may DIFFER between the two sides (the two cameras' own timestamps). A frame
  // whose key has NO resolved anchor → ages out (no pair).
  A.pushPairTestFrame(L, { deviceTimestamp: 9_999_000_000n });
  A.pushPairTestFrame(R, { deviceTimestamp: 9_999_000_000n });
  await sleep(150);
  assert.equal(pair.probe().pairsProduced, 0, "anchor-less identical frames do NOT pair (exact)");
  // A resolved anchor with DISTINCT L/R keys + frames carrying exactly those.
  const kL = 3_000_000_000n;
  const kR = 3_000_555_000n; // per-side keys differ (independent camera clocks)
  const id = pair.pushResolvedAnchor({
    anchorId: 77, tExposure: 3_000_000_000n, stream: 2, leftKey: kL, rightKey: kR,
  });
  assert.equal(id, 77, "pushResolvedAnchor carries the origin anchorId for provenance");
  A.pushPairTestFrame(L, { deviceTimestamp: kL });
  A.pushPairTestFrame(R, { deviceTimestamp: kR });
  const batch = await nextBatch(it, 3000);
  assert(batch && batch.records.length >= 1, "exact-key L/R + resolved anchor join");
  assert.equal(batch.records[0]!.left.deviceTimestamp, kL, "exact join on the LEFT key");
  assert.equal(batch.records[0]!.right.deviceTimestamp, kR, "exact join on the RIGHT key");
  assert.equal(batch.records[0]!.anchorId, 77, "record carries the origin anchorId");
  console.log("33-pair: EXACT resolved per-side key join (+ anchor-less age-out) OK.");
  await it.return?.();
  teardown(pair, L, R);
}

// --- 4b: two-stage ROOT → DOWNSTREAM exact chain -----------------------------
// The root tolerance-matches raw arrivals against a FIN anchor; the completed
// pair's L/R deviceTimestamps become the resolved keys the session forwards to
// the DOWNSTREAM exact brick, which joins the NEXT stage's frames (same
// timestamps, meta-passthrough) by per-side key equality. No re-stamping.
{
  const root = makePair("root");
  const down = makePair("exact");
  const rootIt = root.pair[Symbol.asyncIterator]();
  const downIt = down.pair[Symbol.asyncIterator]();

  const tExp = 6_000_000_000n;
  const kL = tExp;             // left camera arrival (in tolerance of the FIN)
  const kR = tExp + 1_500_000n; // right camera arrival (+1.5 ms, in tolerance)
  root.pair.pushAnchor({ tExposure: tExp, stream: 5, payload: new Float64Array([9.5]) });
  A.pushPairTestFrame(root.L, { deviceTimestamp: kL });
  A.pushPairTestFrame(root.R, { deviceTimestamp: kR });

  const rootBatch = await nextBatch(rootIt, 3000);
  assert(rootBatch && rootBatch.records.length >= 1, "root produced a pair");
  const rec = rootBatch.records[0]!;
  // Forward the resolved anchor to the downstream stage (the I-2 session seam;
  // loop-safe FIN-rate forwarding — per-side keys are the frames' OWN timestamps).
  down.pair.pushResolvedAnchor({
    anchorId: rec.anchorId,
    tExposure: rec.tExposure,
    stream: rec.stream,
    leftKey: rec.left.deviceTimestamp,
    rightKey: rec.right.deviceTimestamp,
    payload: rec.payload,
  });
  // The next stage's frames carry the SAME deviceTimestamps (meta-passthrough).
  A.pushPairTestFrame(down.L, { deviceTimestamp: rec.left.deviceTimestamp });
  A.pushPairTestFrame(down.R, { deviceTimestamp: rec.right.deviceTimestamp });

  const downBatch = await nextBatch(downIt, 3000);
  assert(downBatch && downBatch.records.length >= 1, "downstream exact-joined the next stage");
  const drec = downBatch.records[0]!;
  assert.equal(drec.anchorId, rec.anchorId, "downstream record carries the origin anchorId");
  assert.equal(drec.left.deviceTimestamp, kL, "downstream left joined on the resolved left key");
  assert.equal(drec.right.deviceTimestamp, kR, "downstream right joined on the resolved right key");
  assert.deepEqual(Array.from(drec.payload), [9.5], "enrichment payload rode through the chain");
  console.log("33-pair: two-stage root → downstream exact key-join OK.");
  await rootIt.return?.();
  await downIt.return?.();
  teardown(root.pair, root.L, root.R);
  teardown(down.pair, down.L, down.R);
}

// --- 4c: EXACT join under DUPLICATE / COLLIDING keys -------------------------
// Regression pin for the exact-mode matcher (PairStream::tryMatch/findSide).
// SEMANTIC (verified against the code, and asserted below): each anchor consumes
// EXACTLY ONE left + ONE right frame — findSide returns the FRONT-most (oldest)
// key match, tryMatch erases both matched frames and RETIRES the anchor. So:
//   * Two frames on ONE side sharing a deviceTimestamp key never double-emit and
//     never cross-bind sides; the front duplicate pairs, the other stays pending.
//   * A DUPLICATE resolved-anchor (same leftKey/rightKey) is an INDEPENDENT pool
//     entry: it only matches if a second, still-unconsumed frame pair with those
//     keys exists — otherwise it lingers, bounded by anchorCap. No frame is ever
//     paired twice. Behavior is sane (no double-emit, no wrong-side bind,
//     bounded), so it is PINNED rather than changed.
{
  const { pair, L, R } = makePair("exact");
  const it = pair[Symbol.asyncIterator]();
  const kL = 7_000_000_000n;
  const kR = 7_000_222_000n; // distinct per-side keys (independent camera clocks)

  // Two LEFT frames COLLIDING on kL (distinguishable by width), one RIGHT on kR,
  // and one resolved anchor {kL,kR}.
  pair.pushResolvedAnchor({ anchorId: 11, tExposure: 7_000_000_000n, stream: 1, leftKey: kL, rightKey: kR });
  A.pushPairTestFrame(L, { deviceTimestamp: kL, width: 10, height: 10 }); // front
  A.pushPairTestFrame(L, { deviceTimestamp: kL, width: 20, height: 20 }); // duplicate key
  A.pushPairTestFrame(R, { deviceTimestamp: kR, width: 30, height: 30 });

  const b1 = await nextBatch(it, 3000);
  assert(b1 && b1.records.length === 1, "colliding-key frames yield EXACTLY ONE pair (no double-emit)");
  assert.equal(b1.records[0]!.left.deviceTimestamp, kL, "left bound on kL");
  assert.equal(b1.records[0]!.right.deviceTimestamp, kR, "right bound on kR (no cross-side bind)");
  assert.equal(b1.records[0]!.left.width, 10, "the FRONT (oldest) duplicate-key left was consumed");
  assert.equal(pair.probe().pairsProduced, 1, "meter: exactly one pair from the colliding key");

  // A DUPLICATE resolved anchor (same keys) + a fresh RIGHT frame → pairs the
  // LEFTOVER duplicate-key left frame (width 20, still pending) with the new
  // right. Proves the leftover is reusable and the duplicate anchor is an
  // independent entry — each frame used once, in FIFO order.
  pair.pushResolvedAnchor({ anchorId: 12, tExposure: 7_000_000_000n, stream: 1, leftKey: kL, rightKey: kR });
  A.pushPairTestFrame(R, { deviceTimestamp: kR, width: 40, height: 40 });
  const b2 = await nextBatch(it, 3000);
  assert(b2 && b2.records.length === 1, "duplicate anchor pairs the leftover colliding-key frame");
  assert.equal(b2.records[0]!.left.width, 20, "the SECOND duplicate-key left was consumed (FIFO)");
  assert.equal(b2.records[0]!.anchorId, 12, "the duplicate anchor (independent entry) formed the pair");
  assert.equal(pair.probe().pairsProduced, 2, "two total pairs — each frame paired exactly once");
  console.log("33-pair: EXACT duplicate/colliding-key semantics (no double-emit, FIFO, bounded) OK.");
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

// --- 5b: late anchor AFTER pending-pool eviction -----------------------------
// Pin the eviction/late-anchor interaction. Overflow BOTH pending pools past
// pendingCap so the OLDEST frames age out (drop-oldest, metered). THEN push an
// anchor keyed to an EVICTED frame: the matcher (run by a subsequent "poke"
// frame, since anchors alone don't wake the brick) finds nothing on that side →
// NO pair, NO crash, NO stale binding, and the loss is OBSERVABLE as
// leftDrops/rightDrops. A follow-up anchor keyed to a SURVIVOR still pairs — the
// pool is intact for frames that were NOT aged out.
{
  const { pair, L, R } = makePair("exact", { pendingCap: 4, anchorCap: 16 });
  const it = pair[Symbol.asyncIterator]();
  const base = 800_000_000n;
  // 8 keys per side; pendingCap 4 evicts the oldest four (base..base+3), keeps
  // base+4..base+7. No anchors yet → nothing matches, everything just ages out.
  for (let i = 0; i < 8; i++) {
    A.pushPairTestFrame(L, { deviceTimestamp: base + BigInt(i) });
    A.pushPairTestFrame(R, { deviceTimestamp: base + BigInt(i) });
  }
  await sleep(300);
  const pe = pair.probe();
  assert(pe.leftDrops >= 4 && pe.rightDrops >= 4,
    `oldest pending frames aged out and were metered (L=${pe.leftDrops} R=${pe.rightDrops})`);
  assert.equal(pe.pairsProduced, 0, "no pairs formed before any anchor");

  // Late anchor for an EVICTED key (base) + a poke frame pair (own, unmatched
  // key) to RUN the matcher → the evicted frame is gone, so no pair, no crash.
  // Assert the miss via probe() (NOT the iterator): a raced-out it.next() would
  // stay pending and later swallow the survivor batch below.
  pair.pushResolvedAnchor({ anchorId: 21, tExposure: 0n, stream: 0, leftKey: base, rightKey: base });
  A.pushPairTestFrame(L, { deviceTimestamp: 111_000_000_000n });
  A.pushPairTestFrame(R, { deviceTimestamp: 111_000_000_000n });
  await sleep(300);
  assert.equal(pair.probe().pairsProduced, 0,
    "late anchor for an EVICTED frame forms NO pair (no crash, no stale binding)");

  // Follow-up anchor for a SURVIVOR key (base+6) + a poke to run the matcher →
  // the retained frame still pairs (survivors intact after eviction).
  const kept = base + 6n;
  pair.pushResolvedAnchor({ anchorId: 22, tExposure: 0n, stream: 0, leftKey: kept, rightKey: kept });
  A.pushPairTestFrame(L, { deviceTimestamp: 222_000_000_000n });
  A.pushPairTestFrame(R, { deviceTimestamp: 222_000_000_000n });
  const hit = await nextBatch(it, 3000);
  assert(hit && hit.records.some((r) => r.left.deviceTimestamp === kept),
    "a SURVIVING-key frame still pairs after eviction (pool intact for survivors)");
  assert.equal(pair.probe().pairsProduced, 1, "exactly the survivor pair formed (evicted key never matched)");
  console.log("33-pair: late-anchor-after-eviction (loss metered, no stale pairing, survivors intact) OK.");
  await it.return?.();
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
