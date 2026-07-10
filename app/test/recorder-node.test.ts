// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder Wave 3: the recorder node is a thin driver over the native
// brick (`core.Recorder.*`), so the host is exercised against a FAKE native
// seam — vitest never loads native core (the brick's own lifecycle is gated by
// core/test/40-recorder-brick.ts). Covered here:
//  - `foldStreamStats` — brick cumulative counters → meter DELTAS + UI stats
//    (unchanged from the worker era — the counter shape is identical);
//  - `dispatchFrame` — ruling-3 extras correlation onto the telemetry doc;
//  - `channelMetadata` — advert → VERBATIM channel metadata (ruling 8);
//  - the host lifecycle: connect ordering, schema-constant plumbing, extras
//    gating, churn (add/remove stream + data channels), finalize mapping, the
//    R-2 deadline abort, and the build-failure unwind.

import { describe, expect, it, vi } from "vitest";
import {
  foldStreamStats,
  dispatchFrame,
  channelMetadata,
  createRecorderNode,
  RecorderFinalizedError,
  type StreamFold,
  type StreamCounters,
  type ExtrasMessage,
  type FrameNotice,
  type RecorderNative,
  type NativeFinalizeStats,
  type RecorderPipeConnection,
} from "@orchestrator/recorder-node";

describe("foldStreamStats (brick counters → meter deltas + UI stats)", () => {
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
    // A stream with BOTH causes: 3 queue-overflow drops + 4 burst drops
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
    // The brick keeps ended streams in its counters, so a departed stream still
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

describe("channelMetadata (advert → VERBATIM channel metadata, ruling 8)", () => {
  it("copies opaque pixelFormat / stride / significantBits verbatim", () => {
    const meta = channelMetadata({
      pixelFormat: "BayerRG12p/bz2", // opaque, codec-suffixed — never parsed
      dtype: "U16",
      width: 100,
      height: 50,
      channels: 1,
      bytesPerFrame: 7500,
      stride: 150, // advert's own number (100 * 1.5) — NOT recomputed
      significantBits: 12,
      maxBytes: 8192,
    });
    expect(meta).toEqual({
      dtype: "U16",
      shape: "[50,100]",
      width: "100",
      height: "50",
      channels: "1",
      pixelFormat: "BayerRG12p/bz2",
      significantBits: "12",
      stride: "150",
    });
  });

  it("falls back to bytesPerFrame/height for a missing stride, 0 for missing significantBits", () => {
    const meta = channelMetadata({
      pixelFormat: "Mono8",
      dtype: "U8",
      width: 8,
      height: 4,
      channels: 1,
      bytesPerFrame: 32,
    });
    expect(meta.stride).toBe("8"); // 32 / 4
    expect(meta.significantBits).toBe("0");
  });

  it("writes a 3-dim shape for multi-channel adverts", () => {
    const meta = channelMetadata({
      pixelFormat: "RGBA8",
      dtype: "U8",
      width: 4,
      height: 2,
      channels: 4,
      bytesPerFrame: 32,
    });
    expect(meta.shape).toBe("[2,4,4]");
  });
});

// ============================================================================
// The host, driven over a FAKE native seam.
// ============================================================================

type CreateOpts = Parameters<RecorderNative["create"]>[0];

/** A controllable fake `core.Recorder`: records every call; finalize is a
 *  deferred the test resolves (or leaves pending to exercise the deadline). */
function fakeNative(opts: { notices?: FrameNotice[]; stats?: Record<string, StreamCounters> } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let resolveFinalize: ((s: NativeFinalizeStats) => void) | null = null;
  const state = {
    calls,
    createOpts: null as CreateOpts | null,
    notices: opts.notices ?? [],
    stats: opts.stats ?? {},
    telemetry: [] as Array<{ seq: number; logTimeNs: bigint; payload: string }>,
    aborted: false,
    destroyed: false,
    finalize: (s: NativeFinalizeStats) => resolveFinalize?.(s),
    of: (method: string) => calls.filter((c) => c.method === method),
  };
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  const native: RecorderNative = {
    create(o) {
      calls.push({ method: "create", args: [o] });
      state.createOpts = o;
      return 42;
    },
    addStream: record("addStream") as RecorderNative["addStream"],
    removeStream: record("removeStream") as RecorderNative["removeStream"],
    addDataStream: record("addDataStream") as RecorderNative["addDataStream"],
    removeDataStream: record("removeDataStream") as RecorderNative["removeDataStream"],
    postData: record("postData") as RecorderNative["postData"],
    appendTelemetry(_h, seq, logTimeNs, payload) {
      state.telemetry.push({ seq, logTimeNs, payload });
    },
    takeNotices() {
      const out = state.notices;
      state.notices = [];
      return out;
    },
    stats() {
      return state.stats;
    },
    finalize() {
      calls.push({ method: "finalize", args: [] });
      return new Promise<NativeFinalizeStats>((res) => {
        resolveFinalize = res;
      });
    },
    abort() {
      state.aborted = true;
    },
    destroy() {
      state.destroyed = true;
    },
  };
  return { native, state };
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
    bytesPerFrame: 7500,
    stride: 150,
    significantBits: 12,
    maxBytes: 8192,
  },
  release: () => released.push(pipeId),
});

describe("createRecorderNode (thin native driver)", () => {
  it("passes the schema constants + session metadata into native create", () => {
    const { native, state } = fakeNative();
    createRecorderNode({
      id: "recorder/create",
      path: "/tmp/rec-create",
      streams: {},
      connect: fakeConn([]),
      timestamp: "2026-07-10T00:00:00.000Z",
      native,
    });
    const o = state.createOpts!;
    expect(o.profile).toBe("fovea");
    expect(o.library).toBe("FoveaCamApp");
    expect(o.session).toEqual({ timestamp: "2026-07-10T00:00:00.000Z", app: "FoveaCamApp" });
    expect(o.sessionMetaName).toBe("fovea:session");
    expect(o.finalizeMetaName).toBe("fovea:finalize");
    expect(o.wideCameraMetaName).toBe("fovea:wide-camera");
    expect(o.rawFrameSchemaName).toBe("fovea.raw_frame/v1");
    expect(o.rawFrameEncoding).toBe("x-fovea-raw");
    expect(o.telemetryTopic).toBe("telemetry");
    expect(o.schemaEncoding).toBe("jsonschema");
    // One `<path>.fcap` file per recording — no per-recording directory.
    expect(o.filePath).toBe("/tmp/rec-create.fcap");
    expect(o.cameraMatrix).toBeUndefined();
  });

  it("JSON-encodes the wide cameraMatrix singleton (strings stay strings)", () => {
    const { native, state } = fakeNative();
    createRecorderNode({
      id: "recorder/cam",
      path: "/tmp/rec-cam",
      streams: {},
      connect: fakeConn([]),
      timestamp: "t",
      cameraMatrix: {
        matrix: [[1000, 0, 512], [0, 1000, 384], [0, 0, 1]],
        distortion: [0.1, -0.2, 0, 0, 0.05],
        model: "pinhole",
      },
      native,
    });
    expect(state.createOpts!.cameraMatrix).toEqual({
      matrix: "[[1000,0,512],[0,1000,384],[0,0,1]]",
      distortion: "[0.1,-0.2,0,0,0.05]",
      model: "pinhole",
    });
  });

  it("taps every initial stream with VERBATIM advert metadata", () => {
    const { native, state } = fakeNative();
    createRecorderNode({
      id: "recorder/init",
      path: "/tmp/rec-init",
      streams: { left: { pipeId: "pipe/L" } },
      connect: (id) => advert12p(id, []),
      timestamp: "t",
      native,
    });
    const add = state.of("addStream");
    expect(add).toHaveLength(1);
    const [, name, pipeId, metadata] = add[0]!.args as [number, string, string, Record<string, string>];
    expect(name).toBe("left");
    expect(pipeId).toBe("pipe/L");
    expect(metadata).toMatchObject({
      pixelFormat: "BayerRG12p/bz2", // opaque, unchanged
      dtype: "U16",
      stride: "150", // verbatim
      significantBits: "12", // verbatim (NOT derived from the suffixed name)
    });
  });

  it("gates per-frame extras to extrasStreams only (center opted out)", () => {
    const { native, state } = fakeNative();
    createRecorderNode({
      id: "recorder/gating",
      path: "/tmp/rec-gating",
      streams: {
        "left-fovea": { pipeId: "pipe/L" },
        center: { pipeId: "pipe/C" },
        "right-fovea": { pipeId: "pipe/R" },
      },
      connect: fakeConn([]),
      timestamp: "t",
      extrasStreams: ["left-fovea", "right-fovea"],
      native,
    });
    const byName = Object.fromEntries(
      state.of("addStream").map((c) => [c.args[1], c.args[4]]),
    );
    expect(byName).toEqual({ "left-fovea": true, center: false, "right-fovea": true });
  });

  it("posts notices for every stream when extrasStreams is omitted (back-compat)", () => {
    const { native, state } = fakeNative();
    createRecorderNode({
      id: "recorder/gating-default",
      path: "/tmp/rec-gating-default",
      streams: { a: { pipeId: "pipe/a" }, b: { pipeId: "pipe/b" } },
      connect: fakeConn([]),
      timestamp: "t",
      native,
    });
    expect(state.of("addStream").every((c) => c.args[4] === true)).toBe(true);
  });

  it("releases connected pipes when native create throws (build unwind)", () => {
    const released: string[] = [];
    const { native } = fakeNative();
    native.create = () => {
      throw new Error("no disk");
    };
    expect(() =>
      createRecorderNode({
        id: "recorder/fail",
        path: "/tmp/rec-fail",
        streams: { a: { pipeId: "pipe/a" } },
        connect: fakeConn(released),
        timestamp: "t",
        native,
      }),
    ).toThrow("no disk");
    expect(released).toEqual(["pipe/a"]); // no orphaned refcount
  });

  it("aborts + releases when an initial tap fails (unknown pipe)", () => {
    const released: string[] = [];
    const { native, state } = fakeNative();
    native.addStream = () => {
      throw new Error("unknown pipe");
    };
    expect(() =>
      createRecorderNode({
        id: "recorder/fail-tap",
        path: "/tmp/rec-fail-tap",
        streams: { a: { pipeId: "pipe/a" } },
        connect: fakeConn(released),
        timestamp: "t",
        native,
      }),
    ).toThrow("unknown pipe");
    expect(state.aborted).toBe(true);
    expect(state.destroyed).toBe(true);
    expect(released).toEqual(["pipe/a"]);
  });
});

describe("createRecorderNode dynamic streams + data channels", () => {
  it("addStream connects the pipe and taps it; re-adding a live name throws", () => {
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/add",
      path: "/tmp/rec-add",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "t",
      native,
    });
    node.addStream("left", { pipeId: "pipe/L" });
    const add = state.of("addStream");
    expect(add).toHaveLength(1);
    expect(add[0]!.args[1]).toBe("left");
    expect((add[0]!.args[3] as Record<string, string>).significantBits).toBe("12");
    expect(() => node.addStream("left", { pipeId: "pipe/L2" })).toThrow(RecorderFinalizedError);
  });

  it("removeStream detaches the tap and releases the pipe IMMEDIATELY (synchronous contract)", () => {
    const released: string[] = [];
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/remove",
      path: "/tmp/rec-remove",
      streams: { left: { pipeId: "pipe/L" } },
      connect: (id) => advert12p(id, released),
      timestamp: "t",
      native,
    });
    node.removeStream("left");
    expect(state.of("removeStream").map((c) => c.args[1])).toEqual(["left"]);
    // The brick's tap detach is synchronous, so the pipe releases at once —
    // the worker era's async stream-ended dance is gone.
    expect(released).toEqual(["pipe/L"]);
    // Unknown name → no-op.
    node.removeStream("nope");
    expect(state.of("removeStream")).toHaveLength(1);
  });

  it("addStream / addDataStream after stop() throw RecorderFinalizedError", async () => {
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/finalized",
      path: "/tmp/rec-finalized",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "t",
      finalizeDeadlineMs: 10,
      native,
    });
    const stopping = node.stop(); // sets finalizing synchronously
    expect(() => node.addStream("late", { pipeId: "pipe/late" })).toThrow(RecorderFinalizedError);
    expect(() => node.addDataStream("fovea/late")).toThrow(RecorderFinalizedError);
    state.finalize({ messageCount: 0n, chunkCount: 0, bytes: 0 });
    await stopping;
  });

  it("data channels: addDataStream/postData/removeDataStream plumb through, with guards", () => {
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/data",
      path: "/tmp/rec-data",
      streams: {},
      connect: (id) => advert12p(id, []),
      timestamp: "t",
      native,
    });
    // postData for an unadded channel is silently dropped (not posted).
    node.postData("fovea/1", { tNs: 1, bbox: { x: 0, y: 0, width: 1, height: 1 }, frames: {} });
    expect(state.of("postData")).toHaveLength(0);

    node.addDataStream("fovea/1");
    expect(state.of("addDataStream").map((c) => c.args[1])).toEqual(["fovea/1"]);

    node.postData("fovea/1", {
      tNs: 1234,
      bbox: { x: 10, y: 20, width: 30, height: 40 },
      frames: { left: 7, center: 7, right: 8 },
    });
    const data = state.of("postData");
    expect(data).toHaveLength(1);
    expect(data[0]!.args[1]).toBe("fovea/1");
    expect(JSON.parse(data[0]!.args[2] as string)).toEqual({
      tNs: 1234,
      bbox: { x: 10, y: 20, width: 30, height: 40 },
      frames: { left: 7, center: 7, right: 8 },
    });

    node.removeDataStream("fovea/1");
    expect(state.of("removeDataStream").map((c) => c.args[1])).toEqual(["fovea/1"]);
    // After removal, postData is dropped again.
    node.postData("fovea/1", { tNs: 2, bbox: { x: 0, y: 0, width: 1, height: 1 }, frames: {} });
    expect(state.of("postData")).toHaveLength(1); // unchanged
  });
});

describe("createRecorderNode stop() + ruling-3 round-trip", () => {
  it("finalizes, maps native stats to FinalizeStats, destroys, releases pipes AFTER", async () => {
    const released: string[] = [];
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/stop",
      path: "/tmp/rec-stop",
      streams: { a: { pipeId: "pipe/a" } },
      connect: fakeConn(released),
      timestamp: "t",
      native,
    });
    const stopping = node.stop();
    expect(released).toEqual([]); // pipes NOT released while finalize pends
    state.finalize({ messageCount: 123n, chunkCount: 4, bytes: 999 });
    const stats = await stopping;
    // bigint messageCount crosses to the FinalizeStats string shape.
    expect(stats).toEqual({ messageCount: "123", chunkCount: 4, bytes: 999 });
    expect(state.destroyed).toBe(true);
    expect(released).toEqual(["pipe/a"]); // released only after finalize+destroy
    // stop() is idempotent.
    expect(await node.stop()).toEqual({ messageCount: "0", chunkCount: 0, bytes: 0 });
  });

  it("stop() aborts on a wedged finalize (R-2 deadline) and releases pipes", async () => {
    const released: string[] = [];
    const { native, state } = fakeNative();
    const node = createRecorderNode({
      id: "recorder/deadline",
      path: "/tmp/rec-deadline",
      streams: { center: { pipeId: "pipe/center" } },
      connect: fakeConn(released),
      timestamp: "t",
      finalizeDeadlineMs: 20, // race the never-resolving fake finalize
      native,
    });
    const stats = await node.stop();
    // Deadline path → truncated stats, native aborted, container left on disk.
    expect(stats).toEqual({ messageCount: "0", chunkCount: 0, bytes: 0 });
    expect(state.aborted).toBe(true);
    // Ordering preserved: pipes released only AFTER the (forced) stop.
    expect(released).toEqual(["pipe/center"]);
  });

  it("drains notices at stop(): extras ride back via appendTelemetry, co-clocked", async () => {
    const { native, state } = fakeNative({
      notices: [
        { stream: "left", seq: 5, logTimeNs: 111n, tNs: 2_000_000_000n },
        { stream: "center", seq: 6, logTimeNs: 112n, tNs: 112n },
      ],
    });
    const node = createRecorderNode({
      id: "recorder/extras",
      path: "/tmp/rec-extras",
      streams: { left: { pipeId: "pipe/L" }, center: { pipeId: "pipe/C" } },
      connect: fakeConn([]),
      timestamp: "t",
      onFrame: (stream, seq) => (stream === "left" ? { volt: { x: seq, y: 0 } } : null),
      native,
    });
    const stopping = node.stop(); // the final pre-finalize drain dispatches
    state.finalize({ messageCount: 0n, chunkCount: 0, bytes: 0 });
    await stopping;
    expect(state.telemetry).toHaveLength(1); // center returned null → no doc
    const doc = state.telemetry[0]!;
    expect(doc.seq).toBe(5);
    expect(doc.logTimeNs).toBe(111n); // the OWNING frame's container axis time
    expect(JSON.parse(doc.payload)).toMatchObject({
      stream: "left",
      seq: 5,
      t: 2, // trusted capture time in seconds
      volt: { x: 5, y: 0 },
    });
  });

  it("re-folds stats AFTER finalize so the drain's tail frames are counted", async () => {
    // The R-1 drain writes frames AFTER the pre-finalize poll; the host must
    // fold once more post-finalize or `stats()` undercounts (the worker era's
    // final stats push, preserved).
    const stats: Record<string, StreamCounters> = {
      a: { ingested: 5, dropped: 0, droppedQueue: 0, droppedRing: 0, written: 5, bytes: 500 },
    };
    const { native, state } = fakeNative({ stats });
    const node = createRecorderNode({
      id: "recorder/tailfold",
      path: "/tmp/rec-tailfold",
      streams: { a: { pipeId: "pipe/a" } },
      connect: fakeConn([]),
      timestamp: "t",
      native,
    });
    const stopping = node.stop(); // pre-finalize poll sees written=5
    // The drain writes 3 more frames before the writer closes the container.
    stats.a = { ingested: 8, dropped: 0, droppedQueue: 0, droppedRing: 0, written: 8, bytes: 800 };
    state.finalize({ messageCount: 8n, chunkCount: 8, bytes: 800 });
    await stopping;
    expect(node.stats().a).toMatchObject({ frames: 8, bytes: 800 });
  });

  it("folds native stats into the UI shape on the stop() drain", async () => {
    const { native, state } = fakeNative({
      stats: {
        a: { ingested: 10, dropped: 2, droppedQueue: 2, droppedRing: 0, written: 8, bytes: 800 },
      },
    });
    const node = createRecorderNode({
      id: "recorder/uistats",
      path: "/tmp/rec-uistats",
      streams: { a: { pipeId: "pipe/a" } },
      connect: fakeConn([]),
      timestamp: "t",
      native,
    });
    const stopping = node.stop();
    state.finalize({ messageCount: 8n, chunkCount: 8, bytes: 800 });
    await stopping;
    expect(node.stats().a).toMatchObject({
      frames: 8,
      dropped: 2,
      droppedQueue: 2,
      droppedRing: 0,
      bytes: 800,
    });
  });
});
