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
  type SeqRead,
  type StreamFold,
  type StreamCounters,
  type ExtrasMessage,
  type WorkerLike,
  type WorkerStreamInit,
  type RecorderPipeConnection,
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
      "left-fovea": { ingested: 10, dropped: 2, written: 8, bytes: 800 },
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
      "left-fovea": { ingested: 15, dropped: 2, written: 13, bytes: 1300 },
    });
    expect(meter.ingest).toHaveBeenCalledWith("left-fovea", 5);
    expect(meter.emit).toHaveBeenCalledWith("written", 5);
    expect(meter.emit).toHaveBeenCalledWith("bytes", 500);
    expect(meter.drop).not.toHaveBeenCalled(); // no new drops
    expect(out["left-fovea"]).toMatchObject({ frames: 13, dropped: 2, bytes: 1300 });
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
