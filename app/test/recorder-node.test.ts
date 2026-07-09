// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 2: the recorder node's PURE parts, driven with
// fakes so vitest never loads native core or spawns a worker:
//  - `runStreamConsumer` — the FIFO consume state machine (ordered delivery,
//    Gone drop-accounting + jump, Closed drain, torn-read retry, finalize-drain
//    to a snapshot / early caught-up exit);
//  - `foldStreamStats` — worker cumulative counters → meter DELTAS + UI stats;
//  - `dispatchFrame` — ruling-3 extras correlation onto the telemetry doc.

import { describe, expect, it, vi } from "vitest";
import {
  runStreamConsumer,
  foldStreamStats,
  dispatchFrame,
  createRecorderNode,
  RecorderFinalizedError,
  type SeqRead,
  type StreamFold,
  type StreamCounters,
  type ExtrasMessage,
  type WorkerLike,
  type WorkerStreamInit,
  type RecorderPipeConnection,
  type RecorderNodeIn,
  type RecorderNodeOut,
} from "@orchestrator/recorder-node";

/** Drive `runStreamConsumer` with a scripted `read(want)` and collect frames. */
async function drive(
  script: (want: bigint) => SeqRead,
  opts: { startSeq?: bigint; drainTarget?: () => bigint | null } = {},
) {
  const delivered: bigint[] = [];
  const deviceTimes: (bigint | undefined)[] = [];
  let drops = 0;
  let delays = 0;
  await runStreamConsumer({
    dst: new Uint8Array(16),
    startSeq: opts.startSeq ?? 1n,
    bytesFor: (w, h) => w * h,
    read: script,
    delay: async () => {
      delays++;
    },
    drainTarget: opts.drainTarget ?? (() => null),
    onDrop: (n) => {
      drops += n;
    },
    onFrame: (_view, seq, _w, _h, deviceTs) => {
      delivered.push(seq);
      deviceTimes.push(deviceTs);
    },
  });
  return { delivered, drops, delays, deviceTimes };
}

describe("runStreamConsumer (FIFO consume state machine)", () => {
  it("delivers frames in order and stops on Closed", async () => {
    const { delivered, drops } = await drive((want) =>
      want <= 3n ? { seq: want, width: 2, height: 2 } : { closed: true },
    );
    expect(delivered).toEqual([1n, 2n, 3n]);
    expect(drops).toBe(0);
  });

  it("accounts a Gone gap and jumps to the oldest live seq", async () => {
    const { delivered, drops } = await drive((want) => {
      if (want === 1n) return { gone: true, oldestSeq: 4n };
      if (want === 4n) return { seq: 4n, width: 1, height: 1 };
      return { closed: true };
    });
    expect(drops).toBe(3); // 1,2,3 recycled
    expect(delivered).toEqual([4n]);
  });

  it("retries a torn read (null) and backs off on NotYet", async () => {
    const results: SeqRead[] = [null, { notYet: true }, { seq: 1n, width: 1, height: 1 }, { closed: true }];
    let i = 0;
    const { delivered, delays } = await drive(() => results[i++]!);
    expect(delivered).toEqual([1n]);
    expect(delays).toBe(1); // one NotYet backoff
  });

  it("drains up to the finalize snapshot then stops (ignoring later frames)", async () => {
    // Producer always has the next frame; finalize snapshotted latest = 3.
    const { delivered } = await drive((want) => ({ seq: want, width: 1, height: 1 }), {
      drainTarget: () => 3n,
    });
    expect(delivered).toEqual([1n, 2n, 3n]);
  });

  it("exits early when draining and already caught up (NotYet)", async () => {
    const { delivered } = await drive(
      (want) => (want <= 2n ? { seq: want, width: 1, height: 1 } : { notYet: true }),
      { drainTarget: () => 10n },
    );
    expect(delivered).toEqual([1n, 2n]);
  });

  it("surfaces the frame's device timestamp to onFrame, undefined when unstamped", async () => {
    // The addon's okResult marshals meta.deviceTimestamp only when the source
    // stamps it (hardware does, the fake camera does not). The state machine
    // must pass it through verbatim so the worker can prefer trusted device
    // time over its monotonic fallback (R-2 fix item 1).
    const { delivered, deviceTimes } = await drive((want) => {
      if (want === 1n) return { seq: 1n, width: 1, height: 1, meta: { deviceTimestamp: 111n } };
      if (want === 2n) return { seq: 2n, width: 1, height: 1 }; // unstamped source
      if (want === 3n) return { seq: 3n, width: 1, height: 1, meta: {} }; // meta w/o device ts
      return { closed: true };
    });
    expect(delivered).toEqual([1n, 2n, 3n]);
    expect(deviceTimes).toEqual([111n, undefined, undefined]);
  });

  it("honors a non-1 startSeq (producer latest at connect)", async () => {
    const { delivered } = await drive(
      (want) => (want <= 6n ? { seq: want, width: 1, height: 1 } : { closed: true }),
      { startSeq: 5n },
    );
    expect(delivered).toEqual([5n, 6n]);
  });

  it("writes the reader's ACTUAL payload length (ring-v5 bytes), byte-exact, not dim-derived", async () => {
    // A compressed/codec stream: per-frame length varies and is NOT
    // width*height*channels*bytesPerElement. The reader reports `bytes`; the
    // consumer must slice `dst` to THAT (never bytesFor, never w*h*c*bpe), and
    // the exact bytes must round-trip. `bytesFor` returns a wrong 999 to prove
    // it is ignored whenever `bytes` is present.
    const dst = new Uint8Array(64);
    const frames: number[][] = [];
    await runStreamConsumer({
      dst,
      startSeq: 1n,
      bytesFor: () => 999,
      read: (want) => {
        if (want > 2n) return { closed: true };
        const n = Number(want) * 3; // 3, then 6 — differs from 8*8 dims
        for (let i = 0; i < n; i++) dst[i] = Number(want) * 10 + i;
        return { seq: want, width: 8, height: 8, bytes: n };
      },
      delay: async () => {},
      drainTarget: () => null,
      onDrop: () => {},
      onFrame: (view) => frames.push([...view]),
    });
    expect(frames).toEqual([
      [10, 11, 12],
      [20, 21, 22, 23, 24, 25],
    ]);
  });

  it("falls back to bytesFor (advert frame size) when the ring reports no per-frame bytes (v4)", async () => {
    const lengths: number[] = [];
    await runStreamConsumer({
      dst: new Uint8Array(64),
      startSeq: 1n,
      bytesFor: () => 12, // advert bytesPerFrame — used when `bytes` is absent
      read: (want) => (want <= 2n ? { seq: want, width: 2, height: 2 } : { closed: true }),
      delay: async () => {},
      drainTarget: () => null,
      onDrop: () => {},
      onFrame: (view) => lengths.push(view.byteLength),
    });
    expect(lengths).toEqual([12, 12]);
  });
});

describe("foldStreamStats (worker counters → meter deltas + UI stats)", () => {
  function fakeMeter() {
    const ingest = vi.fn();
    const emit = vi.fn();
    const drop = vi.fn();
    return { ingest, emit, drop };
  }

  it("folds cumulative counters as deltas and reports per-stream UI stats", () => {
    const meter = fakeMeter();
    const folds = new Map<string, StreamFold>();
    const first: Record<string, StreamCounters> = {
      "left-fovea": { ingested: 10, dropped: 2, droppedQueue: 0, droppedRing: 2, written: 8, bytes: 800 },
    };
    let out = foldStreamStats(meter, folds, first);
    expect(meter.ingest).toHaveBeenCalledWith("left-fovea", 10);
    expect(meter.drop).toHaveBeenCalledWith("ring-recycled", 2);
    expect(meter.emit).toHaveBeenCalledWith("written", 8);
    expect(meter.emit).toHaveBeenCalledWith("bytes", 800);
    expect(out["left-fovea"]).toMatchObject({ frames: 8, dropped: 2, bytes: 800 });

    // Second snapshot: only the DELTA is folded into the meter.
    meter.ingest.mockClear();
    meter.emit.mockClear();
    meter.drop.mockClear();
    out = foldStreamStats(meter, folds, {
      "left-fovea": { ingested: 15, dropped: 2, droppedQueue: 0, droppedRing: 2, written: 13, bytes: 1300 },
    });
    expect(meter.ingest).toHaveBeenCalledWith("left-fovea", 5);
    expect(meter.emit).toHaveBeenCalledWith("written", 5);
    expect(meter.emit).toHaveBeenCalledWith("bytes", 500);
    expect(meter.drop).not.toHaveBeenCalled(); // no new drops
    expect(out["left-fovea"]).toMatchObject({ frames: 13, dropped: 2, bytes: 1300 });
  });

  it("splits drop attribution into queue-overflow vs ring-recycled meter reasons (F2)", () => {
    const meter = fakeMeter();
    const folds = new Map<string, StreamFold>();
    // A stream with BOTH causes: 3 queue-overflow drops + 4 ring-lapped drops
    // (dropped == droppedQueue + droppedRing — the pinned invariant).
    let out = foldStreamStats(meter, folds, {
      wide: { ingested: 20, dropped: 7, droppedQueue: 3, droppedRing: 4, written: 13, bytes: 1300 },
    });
    expect(meter.drop).toHaveBeenCalledWith("queue-overflow", 3);
    expect(meter.drop).toHaveBeenCalledWith("ring-recycled", 4);
    // The UI stats carry the split so a rig run reads the cause without devtools.
    expect(out.wide).toMatchObject({ frames: 13, dropped: 7, droppedQueue: 3, droppedRing: 4 });

    // Next snapshot: only the queue cause advanced — just that delta is metered.
    meter.drop.mockClear();
    out = foldStreamStats(meter, folds, {
      wide: { ingested: 25, dropped: 9, droppedQueue: 5, droppedRing: 4, written: 16, bytes: 1600 },
    });
    expect(meter.drop).toHaveBeenCalledWith("queue-overflow", 2);
    expect(meter.drop).not.toHaveBeenCalledWith("ring-recycled", expect.anything());
    expect(out.wide).toMatchObject({ dropped: 9, droppedQueue: 5, droppedRing: 4 });
  });

  it("folds over a GROWING then shrinking-but-retained key set (churn)", () => {
    const meter = fakeMeter();
    const folds = new Map<string, StreamFold>();
    // Wave 1: only stream `a`.
    foldStreamStats(meter, folds, { a: { ingested: 5, dropped: 0, droppedQueue: 0, droppedRing: 0, written: 5, bytes: 50 } });
    // Wave 2: `b` churned IN mid-run (a new key mid-snapshot); `a` unchanged.
    // The worker keeps ended streams in its counters, so a departed stream still
    // appears here with frozen totals — the fold must handle the changing set.
    meter.ingest.mockClear();
    const out = foldStreamStats(meter, folds, {
      a: { ingested: 5, dropped: 0, droppedQueue: 0, droppedRing: 0, written: 5, bytes: 50 }, // ended, frozen
      b: { ingested: 3, dropped: 1, droppedQueue: 0, droppedRing: 1, written: 2, bytes: 20 }, // newly added
    });
    expect(meter.ingest).toHaveBeenCalledWith("b", 3);
    expect(meter.ingest).not.toHaveBeenCalledWith("a", expect.anything()); // no delta
    expect(out.a).toMatchObject({ frames: 5, bytes: 50 }); // retained truthfully
    expect(out.b).toMatchObject({ frames: 2, dropped: 1, bytes: 20 });
  });
});

describe("dispatchFrame (ruling-3 extras correlation)", () => {
  it("builds a stream+seq-correlated telemetry doc and posts it", () => {
    const posts: ExtrasMessage[] = [];
    // The trusted capture time (tNs) rides the doc's `t`; the message logs on
    // the OWNING frame's container axis (logTimeNs), which differs when the
    // source stamps device time — telemetry must stay co-clocked with frames.
    const msg = dispatchFrame(
      (stream, seq, tNs) =>
        stream === "left-fovea"
          ? { volt: { x: 1, y: 2 }, "volt.unit": "volt", seenTNs: String(tNs) }
          : null,
      (m) => posts.push(m),
      { stream: "left-fovea", seq: 7, logTimeNs: 900_000_000n, tNs: 1_500_000_000n },
    );
    expect(msg).not.toBeNull();
    expect(msg!.logTimeNs).toBe(900_000_000n); // message logs on the frame axis
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(msg!.payload);
    expect(payload).toMatchObject({
      stream: "left-fovea",
      seq: 7,
      t: 1.5, // trusted capture time, ns → seconds (NOT the axis time)
      seenTNs: "1500000000", // callback received the trusted device time
      volt: { x: 1, y: 2 },
      "volt.unit": "volt",
    });
  });

  it("posts nothing when the callback returns null or empty extras", () => {
    const posts: unknown[] = [];
    const notice = { stream: "center", seq: 0, logTimeNs: 0n, tNs: 0n };
    expect(dispatchFrame(() => null, (m) => posts.push(m), notice)).toBeNull();
    expect(dispatchFrame(() => ({}), (m) => posts.push(m), notice)).toBeNull();
    expect(dispatchFrame(undefined, (m) => posts.push(m), notice)).toBeNull();
    expect(posts).toHaveLength(0);
  });
});

// A fake worker that swallows every message (never replies to "finalize").
function wedgedWorker(): WorkerLike {
  return {
    postMessage() {},
    on() {},
    terminate() {},
  };
}

const fakeConn =
  (released: string[]) =>
  (pipeId: string): RecorderPipeConnection => ({
    shmName: `shm/${pipeId}`,
    spec: {
      pixelFormat: "Mono8",
      dtype: "U8",
      width: 2,
      height: 2,
      channels: 1,
      bytesPerFrame: 4,
      maxBytes: 4,
    },
    release: () => released.push(pipeId),
  });

describe("createRecorderNode host lifecycle", () => {
  it("stop() force-terminates on a wedged finalize (deadline) and releases pipes AFTER", async () => {
    let terminated = false;
    const released: string[] = [];
    const node = createRecorderNode({
      id: "recorder/test-deadline",
      path: "/tmp/recorder-deadline-test",
      streams: { center: { pipeId: "pipe/center" } },
      connect: fakeConn(released),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused-in-fake",
      finalizeDeadlineMs: 20, // race the never-replying worker
      spawn: () => {
        const w = wedgedWorker();
        w.terminate = () => {
          terminated = true;
        };
        return w;
      },
    });
    const stats = await node.stop();
    // Deadline path → truncated stats, worker terminated, container left on disk.
    expect(stats).toEqual({ messageCount: "0", chunkCount: 0, bytes: 0 });
    expect(terminated).toBe(true);
    // Ordering preserved: pipes released only AFTER the (forced) worker stop.
    expect(released).toEqual(["pipe/center"]);
    // stop() is idempotent.
    expect(await node.stop()).toEqual({ messageCount: "0", chunkCount: 0, bytes: 0 });
  });

  it("gates per-frame notices to extrasStreams only (center opted out)", () => {
    let captured: WorkerStreamInit[] = [];
    const node = createRecorderNode({
      id: "recorder/test-gating",
      path: "/tmp/recorder-gating-test",
      streams: {
        "left-fovea": { pipeId: "pipe/L" },
        center: { pipeId: "pipe/C" },
        "right-fovea": { pipeId: "pipe/R" },
      },
      connect: fakeConn([]),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused-in-fake",
      extrasStreams: ["left-fovea", "right-fovea"],
      spawn: (streams) => {
        captured = streams;
        return wedgedWorker();
      },
    });
    const byName = Object.fromEntries(captured.map((s) => [s.name, s.wantsExtras]));
    expect(byName).toEqual({ "left-fovea": true, center: false, "right-fovea": true });
    void node; // constructed; no teardown needed (fake worker)
  });

  it("posts notices for every stream when extrasStreams is omitted (back-compat)", () => {
    let captured: WorkerStreamInit[] = [];
    createRecorderNode({
      id: "recorder/test-gating-default",
      path: "/tmp/recorder-gating-default",
      streams: { a: { pipeId: "pipe/a" }, b: { pipeId: "pipe/b" } },
      connect: fakeConn([]),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused-in-fake",
      spawn: (streams) => {
        captured = streams;
        return wedgedWorker();
      },
    });
    expect(captured.every((s) => s.wantsExtras)).toBe(true);
  });
});

// A controllable fake worker: records everything posted to it and lets a test
// drive the worker→main channel (so host-side orchestration — churn releases,
// data-channel plumbing, start metadata — is exercised without a real thread).
function controllableWorker() {
  const posted: RecorderNodeIn[] = [];
  let onMessage: ((m: RecorderNodeOut) => void) | undefined;
  const worker: WorkerLike = {
    postMessage: (m) => void posted.push(m as RecorderNodeIn),
    on: (event, cb) => {
      if (event === "message") onMessage = cb as (m: RecorderNodeOut) => void;
    },
    terminate: () => {},
  };
  return {
    worker,
    posted,
    /** Push a worker→main message into the host. */
    emit: (m: RecorderNodeOut) => onMessage?.(m),
    /** Every message of a given type, in order. */
    of: <T extends RecorderNodeIn["type"]>(type: T) =>
      posted.filter((m): m is Extract<RecorderNodeIn, { type: T }> => m.type === type),
  };
}

/** A pipe advert with codec-suffixed opaque pixelFormat + explicit
 *  stride/significantBits — the recorder must copy these VERBATIM. */
const advert12p = (pipeId: string, released: string[]): RecorderPipeConnection => ({
  shmName: `shm/${pipeId}`,
  spec: {
    pixelFormat: "BayerRG12p/bz2", // opaque, codec-suffixed — never parsed
    dtype: "U16",
    width: 100,
    height: 50,
    channels: 1,
    bytesPerFrame: 7500, // 150 * 50
    stride: 150, // advert's own number (100 * 1.5) — NOT recomputed
    significantBits: 12,
    maxBytes: 8192, // over-provisioned slot
  },
  release: () => released.push(pipeId),
});

describe("createRecorderNode dynamic streams + data channels (host orchestration)", () => {
  it("addStream connects the pipe, posts add-stream with verbatim advert fields", () => {
    const fw = controllableWorker();
    const node = createRecorderNode({
      id: "recorder/add",
      path: "/tmp/rec-add",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      spawn: () => fw.worker,
    });
    node.addStream("left", { pipeId: "pipe/L" });
    const add = fw.of("add-stream");
    expect(add).toHaveLength(1);
    expect(add[0]!.stream).toMatchObject({
      name: "left",
      pixelFormat: "BayerRG12p/bz2", // opaque, unchanged
      dtype: "U16",
      width: 100,
      height: 50,
      channels: 1,
      stride: 150, // verbatim
      significantBits: 12, // verbatim (NOT derived from the suffixed name)
      frameBytes: 7500, // advert bytesPerFrame → fallback length
      maxBytes: 8192, // max(maxBytes, bytesPerFrame) → dst allocation
    });
    // Re-adding a live name is rejected (typed).
    expect(() => node.addStream("left", { pipeId: "pipe/L2" })).toThrow(RecorderFinalizedError);
  });

  it("removeStream drains via the worker; the pipe releases only on stream-ended", () => {
    const fw = controllableWorker();
    const released: string[] = [];
    const node = createRecorderNode({
      id: "recorder/remove",
      path: "/tmp/rec-remove",
      streams: { left: { pipeId: "pipe/L" } },
      connect: (id) => advert12p(id, released),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      spawn: () => fw.worker,
    });
    node.removeStream("left");
    expect(fw.of("remove-stream").map((m) => m.name)).toEqual(["left"]);
    expect(released).toEqual([]); // NOT released yet — worker still draining
    fw.emit({ type: "stream-ended", name: "left" });
    expect(released).toEqual(["pipe/L"]); // released only after the confirmation
  });

  it("releases the pipe when a consumer ends because the pipe CLOSED (fovea-slot destroyed)", () => {
    const fw = controllableWorker();
    const released: string[] = [];
    createRecorderNode({
      id: "recorder/closed",
      path: "/tmp/rec-closed",
      streams: { left: { pipeId: "pipe/L" } },
      connect: (id) => advert12p(id, released),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      spawn: () => fw.worker,
    });
    // No removeStream — the worker posts stream-ended because the pipe closed.
    fw.emit({ type: "stream-ended", name: "left" });
    expect(released).toEqual(["pipe/L"]);
  });

  it("addStream / addDataStream after stop() throw RecorderFinalizedError", async () => {
    const fw = controllableWorker();
    const node = createRecorderNode({
      id: "recorder/finalized",
      path: "/tmp/rec-finalized",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      finalizeDeadlineMs: 10,
      spawn: () => fw.worker,
    });
    const stopping = node.stop(); // sets finalizing synchronously
    expect(() => node.addStream("late", { pipeId: "pipe/late" })).toThrow(RecorderFinalizedError);
    expect(() => node.addDataStream("fovea/late")).toThrow(RecorderFinalizedError);
    await stopping;
  });

  it("data channels: addDataStream/postData/removeDataStream plumb through, with guards", () => {
    const fw = controllableWorker();
    const node = createRecorderNode({
      id: "recorder/data",
      path: "/tmp/rec-data",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      spawn: () => fw.worker,
    });
    // postData for an unadded channel is silently dropped (not posted).
    node.postData("fovea/1", { tNs: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, frames: {} });
    expect(fw.of("data")).toHaveLength(0);

    node.addDataStream("fovea/1");
    expect(fw.of("add-data-stream").map((m) => m.name)).toEqual(["fovea/1"]);

    node.postData("fovea/1", {
      tNs: 1234,
      bbox: { x: 10, y: 20, width: 30, height: 40 },
      frames: { left: 7, center: 7, right: 8 },
    });
    const data = fw.of("data");
    expect(data).toHaveLength(1);
    expect(data[0]!.name).toBe("fovea/1");
    expect(JSON.parse(data[0]!.payload)).toEqual({
      tNs: 1234,
      bbox: { x: 10, y: 20, width: 30, height: 40 },
      frames: { left: 7, center: 7, right: 8 },
    });

    node.removeDataStream("fovea/1");
    expect(fw.of("remove-data-stream").map((m) => m.name)).toEqual(["fovea/1"]);
    // After removal, postData is dropped again.
    node.postData("fovea/1", { tNs: 2, bbox: { x: 0, y: 0, width: 1, height: 1 }, frames: {} });
    expect(fw.of("data")).toHaveLength(1); // unchanged
  });

  it("writes the wide cameraMatrix singleton into the start message (JSON-encoded)", () => {
    const fw = controllableWorker();
    createRecorderNode({
      id: "recorder/cam",
      path: "/tmp/rec-cam",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      cameraMatrix: {
        matrix: [[1000, 0, 512], [0, 1000, 384], [0, 0, 1]],
        distortion: [0.1, -0.2, 0, 0, 0.05],
        model: "pinhole", // a string value stays a string
      },
      spawn: () => fw.worker,
    });
    const start = fw.of("start")[0]!;
    expect(start.cameraMatrix).toEqual({
      matrix: "[[1000,0,512],[0,1000,384],[0,0,1]]",
      distortion: "[0.1,-0.2,0,0,0.05]",
      model: "pinhole",
    });
  });

  it("omits cameraMatrix from start when not provided", () => {
    const fw = controllableWorker();
    createRecorderNode({
      id: "recorder/nocam",
      path: "/tmp/rec-nocam",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "2026-07-09T00:00:00.000Z",
      readerPath: "unused",
      spawn: () => fw.worker,
    });
    expect(fw.of("start")[0]!.cameraMatrix).toBeUndefined();
  });
});
