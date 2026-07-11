// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native PORT/PIPE substrate (docs/proposals/native-port-pipe.md) — NO
// hardware: a synthetic TrackResult source (`Port.createTestTrackSource`) is
// piped into a counting sink (`Port.createTestTrackSink`) across all three
// link types. Proves:
//   1. TAG + PARAM GUARDS — tag mismatch → TypeError; crossed per-type params
//      (depth on latest/ring, size on fifo), bad bounds, unknown type → named
//      errors. Runtime tags match the d.ts documentation ("track").
//   2. FIFO — lossless in-order delivery, blocking backpressure under a slow
//      consumer (high-water climbs to the bound; dropped stays 0).
//   3. LATEST — a slow consumer SHEDS stale items (delivered < written,
//      dropped accounts the gap); the newest item still lands.
//   4. RING — drop-OLDEST accounting (non-blocking producer, dropped > 0,
//      delivered ends with the newest items, order preserved).
//   5. PROBE counters + idempotent release.
//   6. TOPOLOGY — the link's edges-only row appears in Topology.report() on
//      connect (with lossy/queue attributes per type) and retires on release.
//   7. TEARDOWN under load — connect/release loops while the producer floods
//      (the Stream eject/drain discipline; no hang, no crash).
//
// Run UNSANDBOXED: node core/test/44-port-pipe.ts

import assert from "node:assert/strict";
import { Port, Topology, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Port as unknown as {
  createTestTrackSource(nodeId: string): Source;
  createTestTrackSink(nodeId: string, tag?: string, port?: string): Sink;
};
const T = Topology as unknown as {
  report(): Array<{
    id: string;
    kind: string;
    edgesOnly?: boolean;
    inputs: Array<{
      from: string;
      port: string;
      type: { kind: string; schema?: string };
      lossy?: boolean;
      queue?: { highWater: number; capacity: number };
    }>;
  }>;
};

type PortHandle = {
  node: string;
  port: string;
  streamTag: string;
  pipe(target: PortHandle, opts?: object): Link;
};
type Link = {
  probe(): {
    type: string;
    capacity: number;
    written: number;
    delivered: number;
    dropped: number;
    highWater: number;
    open: boolean;
  };
  release(): void;
};
type Source = {
  track_out: PortHandle;
  push(r: {
    found: boolean;
    center: { x: number; y: number } | null;
    seq: number;
    deviceTimestamp: bigint;
  }): void;
  release(): void;
};
type Sink = {
  track_in: PortHandle;
  count(): number;
  seqs(): number[];
  stall(ms: number): void;
  release(): void;
};

let nextSeq = 0;
function pushN(src: Source, n: number): number[] {
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) {
    const seq = ++nextSeq;
    seqs.push(seq);
    src.push({
      found: true,
      center: { x: seq, y: 0 },
      seq,
      deviceTimestamp: BigInt(1_000_000_000 + seq * 16_666_667),
    });
  }
  return seqs;
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    assert(Date.now() < deadline, "waitFor timed out");
    await sleep(5);
  }
}

// --- 1: tag + param guards -----------------------------------------------------
{
  const src = P.createTestTrackSource("test/44/src");
  const sink = P.createTestTrackSink("test/44/sink");
  const wrongTag = P.createTestTrackSink("test/44/wrong", "detect");

  // Runtime tags match the d.ts documentation (steering ruling 4).
  assert.equal(src.track_out.streamTag, "track", "out port tag is \"track\"");
  assert.equal(sink.track_in.streamTag, "track", "in port tag is \"track\"");
  assert.equal(src.track_out.node, "test/44/src", "out port node id");
  assert.equal(sink.track_in.port, "measure", "in port default port name");

  assert.throws(
    () => src.track_out.pipe(wrongTag.track_in),
    /tag mismatch/,
    "tag mismatch throws TypeError",
  );
  assert.throws(
    () => src.track_out.pipe(sink.track_in, { type: "nope" }),
    /`type` must be/,
    "unknown link type throws (named)",
  );
  assert.throws(
    () => src.track_out.pipe(sink.track_in, { type: "latest", depth: 8 }),
    /takes no `depth`/,
    "depth on a latest link throws (per-type params can't cross)",
  );
  assert.throws(
    () => src.track_out.pipe(sink.track_in, { type: "fifo", size: 8 }),
    /takes `depth`, not `size`/,
    "size on a fifo link throws",
  );
  assert.throws(
    () => src.track_out.pipe(sink.track_in, { type: "ring", depth: 8 }),
    /takes `size`, not `depth`/,
    "depth on a ring link throws",
  );
  assert.throws(
    () => src.track_out.pipe(sink.track_in, { type: "fifo", depth: 0 }),
    /must be an integer >= 1/,
    "fifo depth 0 throws (named bound)",
  );
  wrongTag.release();
  sink.release();
  src.release();
  console.log("44-port-pipe: tag + per-type param guards OK.");
}

// --- 2: FIFO — lossless order + backpressure + high-water ----------------------
{
  const src = P.createTestTrackSource("test/44/fifo-src");
  const sink = P.createTestTrackSink("test/44/fifo-sink");
  sink.stall(5); // consumer slower than the burst
  const link = src.track_out.pipe(sink.track_in, { type: "fifo", depth: 4 });
  const pushed = pushN(src, 30);
  await waitFor(() => sink.count() >= 30);
  const p = link.probe();
  assert.equal(p.type, "fifo");
  assert.equal(p.capacity, 4);
  assert.equal(p.written, 30, "fifo wrote all 30 (backpressure, no shed)");
  assert.equal(p.delivered, 30, "fifo delivered all 30 (lossless)");
  assert.equal(p.dropped, 0, "fifo dropped none");
  assert(p.highWater >= 2 && p.highWater <= 4, `fifo high-water within bound (${p.highWater})`);
  assert.deepEqual(sink.seqs(), pushed, "fifo delivery preserves order, loses nothing");
  link.release();
  sink.release();
  src.release();
  console.log(`44-port-pipe: fifo lossless order + backpressure (hwm ${p.highWater}/4) OK.`);
}

// --- 3: LATEST — slow consumer sheds stale items --------------------------------
{
  const src = P.createTestTrackSource("test/44/latest-src");
  const sink = P.createTestTrackSink("test/44/latest-sink");
  sink.stall(20); // much slower than the burst
  const link = src.track_out.pipe(sink.track_in); // default latest
  const pushed = pushN(src, 40);
  const last = pushed[pushed.length - 1]!;
  // The NEWEST item always lands (latest-wins converges on the final value).
  await waitFor(() => sink.seqs().includes(last));
  const p = link.probe();
  assert.equal(p.type, "latest");
  assert.equal(p.capacity, 1);
  assert.equal(p.written, 40, "latest wrote all 40 (producer never blocks)");
  assert(p.delivered < 40, `latest sheds under a slow consumer (delivered ${p.delivered})`);
  assert.equal(p.dropped, 40 - p.delivered, "latest drop accounting = written − delivered");
  const seqs = sink.seqs();
  for (let i = 1; i < seqs.length; i++)
    assert(seqs[i]! > seqs[i - 1]!, "latest delivery is monotonic (stale shed, never reordered)");
  // Leaky retention fix (2026-07-11): with take-semantics the channel slot is
  // MOVED out on readout, so a drained link over a STALLED upstream must not
  // pin the last payload — `held` reads false once delivery caught up (the
  // pre-fix cursor+`next` readout kept it true until the next write).
  await waitFor(() => !link.probe().held);
  assert.equal(link.probe().held, false, "drained latest link pins no payload on upstream stall");
  link.release();
  sink.release();
  src.release();
  console.log(`44-port-pipe: latest sheds (delivered ${p.delivered}/40, newest landed), drained slot unpinned OK.`);
}

// --- 4: RING — drop-oldest accounting -------------------------------------------
{
  const src = P.createTestTrackSource("test/44/ring-src");
  const sink = P.createTestTrackSink("test/44/ring-sink");
  sink.stall(20);
  const link = src.track_out.pipe(sink.track_in, { type: "ring", size: 4 });
  const pushed = pushN(src, 40);
  const last = pushed[pushed.length - 1]!;
  await waitFor(() => sink.seqs().includes(last));
  const p = link.probe();
  assert.equal(p.type, "ring");
  assert.equal(p.capacity, 4);
  assert.equal(p.written, 40, "ring wrote all 40 (producer never blocks)");
  assert(p.dropped > 0, `ring drops oldest under overload (${p.dropped})`);
  assert.equal(p.delivered + p.dropped, p.written, "ring accounting: delivered + dropped = written");
  assert(p.highWater >= 2 && p.highWater <= 4, `ring high-water within bound (${p.highWater})`);
  const seqs = sink.seqs();
  for (let i = 1; i < seqs.length; i++)
    assert(seqs[i]! > seqs[i - 1]!, "ring delivery preserves order (oldest shed)");
  assert.equal(seqs[seqs.length - 1], last, "ring keeps the newest item");
  link.release();
  sink.release();
  src.release();
  console.log(`44-port-pipe: ring drop-oldest (dropped ${p.dropped}, hwm ${p.highWater}/4) OK.`);
}

// --- 5 + 6: topology edge appear/retire + idempotent release ---------------------
{
  const src = P.createTestTrackSource("test/44/topo-src");
  const sink = P.createTestTrackSink("test/44/topo-sink");
  const link = src.track_out.pipe(sink.track_in, { type: "fifo", depth: 8 });
  {
    const row = T.report().find((r) => r.edgesOnly && r.id === "test/44/topo-sink");
    assert(row, "edges-only row appears on connect");
    assert.equal(row!.kind, "", "edges-only row leaves the node kind to the owner");
    const edge = row!.inputs[0]!;
    assert.equal(edge.from, "test/44/topo-src", "edge from = producer node");
    assert.equal(edge.port, "measure", "edge port = in-port name");
    assert.equal(edge.type.kind, "track", "edge type from the tag");
    assert.equal(edge.lossy, false, "fifo edge is explicitly lossless");
    assert(edge.queue && edge.queue.capacity === 8, "fifo edge carries queue capacity");
  }
  // A latest link is lossy on the graph.
  const link2 = src.track_out.pipe(sink.track_in);
  {
    const rows = T.report().filter((r) => r.edgesOnly && r.id === "test/44/topo-sink");
    assert.equal(rows.length, 2, "one edges-only row per live link");
    assert(rows.some((r) => r.inputs[0]!.lossy === true), "latest edge is lossy");
  }
  link2.release();
  link.release();
  link.release(); // idempotent (CoreObject contract)
  {
    const rows = T.report().filter((r) => r.edgesOnly && r.id === "test/44/topo-sink");
    assert.equal(rows.length, 0, "edges retire on release");
  }
  sink.release();
  src.release();
  console.log("44-port-pipe: topology edge appear/retire + idempotent release OK.");
}

// --- 7: connect/release under producer load (teardown race) ----------------------
{
  const src = P.createTestTrackSource("test/44/load-src");
  const sink = P.createTestTrackSink("test/44/load-sink");
  sink.stall(2);
  // Flood continuously from a timer while links churn.
  const flood = setInterval(() => pushN(src, 5), 1);
  for (let i = 0; i < 25; i++) {
    const type = (["latest", "fifo", "ring"] as const)[i % 3]!;
    const opts =
      type === "fifo" ? { type, depth: 2 } : type === "ring" ? { type, size: 2 } : { type };
    const link = src.track_out.pipe(sink.track_in, opts);
    await sleep(type === "fifo" ? 15 : 5); // let deliveries + backpressure engage
    link.release(); // under load: close-channel → unsubscribe → join
  }
  clearInterval(flood);
  assert(sink.count() > 0, "deliveries flowed across the churn");
  // The source stream survived every unsubscribe (eject/drain discipline):
  // a fresh link still delivers.
  const link = src.track_out.pipe(sink.track_in, { type: "fifo", depth: 8 });
  sink.stall(0);
  const before = sink.count();
  pushN(src, 5);
  await waitFor(() => sink.count() >= before + 5);
  link.release();
  sink.release();
  src.release();
  console.log("44-port-pipe: connect/release under producer load (25 cycles) OK.");
}

cleanup();
console.log("44-port-pipe: native port/pipe substrate passed.");
