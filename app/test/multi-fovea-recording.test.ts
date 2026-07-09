// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea recording controller (multi-fovea-recording r2.1, wave I-2).
// Everything injected — the recorder node factory, the raw-pipe registry seam,
// the compress seam — so the dts→seq re-keying, the free-run descriptor shape,
// the extras gating, the channel churn, and the compression routing are all
// proven without native core or a worker thread.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createMultiFoveaRecording,
  anchorExtras,
  type MultiFoveaRecordingDeps,
  type MultiFoveaDescriptor,
} from "../modules/multi-fovea/recording";
import {
  createRawPipeRegistry,
  type RawPipeSeam,
} from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { ANCHOR_PAYLOAD } from "@orchestrator/anchor-node";
import type {
  RecorderNodeOptions,
  RecorderNodeHandle,
  RecorderPipeConnection,
  FoveaDescriptor,
} from "@orchestrator/recorder-node";

// --- fakes -------------------------------------------------------------------

function fakeRegistry() {
  const log: string[] = [];
  const seam: RawPipeSeam = {
    advertise: (spec) => (log.push(`advertise:${spec.id}`), 1),
    unadvertise: (id) => void log.push(`unadvertise:${id}`),
    attach: (kind, _cam, id) => void log.push(`attach:${kind}:${id}`),
    detach: (kind, id) => void log.push(`detach:${kind}:${id}`),
  };
  return { registry: createRawPipeRegistry(seam), log };
}

function fakeCompress() {
  const log: string[] = [];
  const seam: CompressPipeSeam = {
    advertise: (spec) => (log.push(`advertise:${spec.id}:${spec.pixelFormat}`), 1),
    unadvertise: (id) => void log.push(`unadvertise:${id}`),
    attach: (src, id) => void log.push(`attach:${src}->${id}`),
    detach: (id) => void log.push(`detach:${id}`),
  };
  return { seam, log };
}

interface FakeNode {
  options: RecorderNodeOptions;
  handle: RecorderNodeHandle;
  posted: Array<{ name: string; doc: MultiFoveaDescriptor }>;
  dataStreams: Set<string>;
  events: string[];
  stopped: boolean;
}

function fakeNodeFactory() {
  const nodes: FakeNode[] = [];
  const createNode = (options: RecorderNodeOptions): RecorderNodeHandle => {
    const node: FakeNode = {
      options,
      posted: [],
      dataStreams: new Set(),
      events: [],
      stopped: false,
      handle: null as unknown as RecorderNodeHandle,
    };
    node.handle = {
      id: options.id,
      filePath: join(options.path, "recording.fovea"),
      stats: () => ({}),
      addStream: () => {},
      removeStream: () => {},
      addDataStream: (name) => {
        node.dataStreams.add(name);
        node.events.push(`add:${name}`);
      },
      removeDataStream: (name) => {
        node.dataStreams.delete(name);
        node.events.push(`remove:${name}`);
      },
      postData: (name, message) => {
        node.posted.push({ name, doc: message as unknown as MultiFoveaDescriptor });
      },
      stop: async () => {
        node.stopped = true;
        return { messageCount: "0", chunkCount: 0, bytes: 0 };
      },
    };
    nodes.push(node);
    return node.handle;
  };
  return { createNode, nodes };
}

const camera = (serial: string) => ({
  source: {
    serial,
    pixel_format: "BayerRG12p",
    getFeatureInt: (n: string) => (n === "Width" ? 640 : 480),
  },
  camera: { native: serial },
});

function makeDeps(overrides: Partial<MultiFoveaRecordingDeps> = {}) {
  const { registry } = fakeRegistry();
  const { createNode, nodes } = fakeNodeFactory();
  const finished: string[] = [];
  const telemetry: unknown[] = [];
  const deps: MultiFoveaRecordingDeps = {
    cameras: () => ({ L: camera("SL"), C: camera("SC"), R: camera("SR") }),
    wideCamera: () => ({ sensor_size: { width: 640, height: 480 } }),
    rawPipes: registry,
    connect: (pipeId): RecorderPipeConnection => ({
      shmName: `shm:${pipeId}`,
      spec: {
        pixelFormat: "BayerRG12p",
        dtype: "U8",
        width: 640,
        height: 480,
        channels: 1,
        bytesPerFrame: 960 * 480,
        stride: 960,
      },
      release: () => {},
    }),
    compressStreams: () => ({ left: false, center: false, right: false }),
    finished: (p) => void finished.push(p),
    telemetry: (patch) => void telemetry.push(patch),
    createNode,
    ...overrides,
  };
  return { deps, registry, nodes, finished, telemetry };
}

const fullPayload = (): Float64Array => {
  const p = new Float64Array(ANCHOR_PAYLOAD.LEN_FULL);
  // volts L(1,2) R(3,4); angles L(5,6) R(7,8); H_L = 10..18, H_R = 20..28
  p.set([1, 2, 3, 4, 5, 6, 7, 8]);
  for (let i = 0; i < 9; i++) p[ANCHOR_PAYLOAD.H_LEFT + i] = 10 + i;
  for (let i = 0; i < 9; i++) p[ANCHOR_PAYLOAD.H_RIGHT + i] = 20 + i;
  return p;
};

const pairRecord = (stream: number, leftDts: bigint, rightDts: bigint) => ({
  anchorId: 1,
  tExposure: 1000n,
  stream,
  payload: fullPayload(),
  left: { deviceTimestamp: leftDts },
  right: { deviceTimestamp: rightDts },
});

const batch = (tNs: bigint | undefined, slots: number[]) => ({
  seq: 1,
  ...(tNs !== undefined ? { deviceTimestamp: tNs } : {}),
  targets: slots.map((i) => ({
    id: String(i),
    ok: true,
    bbox: { x: 10 * i, y: 20, width: 64, height: 64 },
    updateMs: 0.1,
  })),
});

const tmp = () => join(tmpdir(), `mfr-test-${Math.random().toString(36).slice(2)}`);

// --- tests ---------------------------------------------------------------------

describe("multi-fovea recording controller", () => {
  it("acquires the three raw12p pipes and wires the recorder streams", async () => {
    const { deps, registry, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    expect(await rec.start(tmp())).toBe(true);
    expect(registry.refCount("camera/SL/raw12p")).toBe(1);
    expect(registry.refCount("camera/SC/raw12p")).toBe(1);
    expect(registry.refCount("camera/SR/raw12p")).toBe(1);
    const streams = nodes[0]!.options.streams;
    expect(streams.left!.pipeId).toBe("camera/SL/raw12p");
    expect(streams.center!.pipeId).toBe("camera/SC/raw12p");
    expect(streams.right!.pipeId).toBe("camera/SR/raw12p");
    // Wide singleton rides through (ruling 2).
    expect(nodes[0]!.options.cameraMatrix).toEqual({
      sensor_size: { width: 640, height: 480 },
    });
    await rec.stop();
    expect(registry.refCount("camera/SL/raw12p")).toBe(0);
  });

  it("re-keys descriptor L/R pointers from pair records via deviceTimestamp", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    rec.onTargets([{ index: 0, enabled: true, streamId: 7 }]);
    await rec.start(tmp());
    const node = nodes[0]!;
    const onFrame = node.options.onFrame!;
    // Recorder notices build the dts→seq maps (raw12p taps stamp identically
    // to the Frame path).
    onFrame("left", 5, 100n);
    onFrame("right", 6, 200n);
    onFrame("center", 3, 150n);
    // The root pair record for controller stream 7 binds those exposures.
    rec.onPairRecord(pairRecord(7, 100n, 200n));
    rec.onTrackBatch(batch(150n, [0]));
    expect(node.posted.length).toBe(1);
    const { name, doc } = node.posted[0]!;
    expect(name).toBe("fovea/0");
    expect(doc.frames).toEqual({ left: 5, center: 3, right: 6 });
    expect(doc.bbox).toEqual({ x: 0, y: 20, width: 64, height: 64 });
    expect(doc.tNs).toBe(150);
    await rec.stop();
  });

  it("free-run (no pairs): descriptors carry null L/R + the nearest center", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    rec.onTargets([{ index: 2, enabled: true, streamId: null }]);
    await rec.start(tmp());
    const node = nodes[0]!;
    const onFrame = node.options.onFrame!;
    onFrame("center", 10, 1000n);
    onFrame("center", 11, 2000n);
    onFrame("center", 12, 3000n);
    rec.onTrackBatch(batch(2200n, [2]));
    const { doc } = node.posted[0]!;
    // 2200 is nearest 2000 (seq 11); L/R null — the documented free-run shape.
    expect(doc.frames).toEqual({ left: null, center: 11, right: null });
    await rec.stop();
  });

  it("without a batch deviceTimestamp the latest center frame is the sample", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    rec.onTargets([{ index: 0, enabled: true, streamId: null }]);
    await rec.start(tmp());
    const node = nodes[0]!;
    node.options.onFrame!("center", 4, 500n);
    node.options.onFrame!("center", 5, 900n);
    rec.onTrackBatch(batch(undefined, [0]));
    expect(node.posted[0]!.doc.frames.center).toBe(5);
    expect(node.posted[0]!.doc.tNs).toBe(900);
    await rec.stop();
  });

  it("extras gating: L/R answer with the matched anchor payload, center posts none", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    await rec.start(tmp());
    const onFrame = nodes[0]!.options.onFrame!;
    // Unmatched (free-run) → no extras at all.
    expect(onFrame("left", 1, 100n)).toBeNull();
    // Matched: the pair record's payload binds by EXACT deviceTimestamp.
    rec.onPairRecord(pairRecord(1, 100n, 200n));
    const left = onFrame("left", 2, 100n) as Record<string, unknown>;
    expect(left.volt).toEqual({ x: 1, y: 2 });
    expect(left["volt.source"]).toBe("fin-averaged");
    expect(left.angle).toEqual({ x: 5, y: 6 });
    expect(left.affine).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const right = onFrame("right", 2, 200n) as Record<string, unknown>;
    expect(right.volt).toEqual({ x: 3, y: 4 });
    expect(right.affine).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
    // Center never posts extras (its camera matrix is the §2 singleton).
    expect(onFrame("center", 3, 100n)).toBeNull();
    await rec.stop();
  });

  it("descriptor channels churn with target arm/disarm", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    rec.onTargets([{ index: 0, enabled: true, streamId: null }]);
    await rec.start(tmp());
    const node = nodes[0]!;
    expect(node.events).toEqual(["add:fovea/0"]);
    rec.onTargets([
      { index: 0, enabled: true, streamId: null },
      { index: 1, enabled: true, streamId: null },
    ]);
    expect(node.dataStreams).toEqual(new Set(["fovea/0", "fovea/1"]));
    rec.onTargets([{ index: 1, enabled: true, streamId: null }]);
    expect(node.dataStreams).toEqual(new Set(["fovea/1"]));
    // A disarmed target's observations no longer post.
    rec.onTrackBatch(batch(1n, [0]));
    expect(node.posted.length).toBe(0);
    await rec.stop();
  });

  it("routes a flagged stream through the /zlib sibling with injected significantBits", async () => {
    const compress = fakeCompress();
    const { deps, nodes } = makeDeps({
      compress: compress.seam,
      compressStreams: () => ({ left: true, center: false, right: false }),
    });
    const rec = createMultiFoveaRecording(deps);
    await rec.start(tmp());
    const node = nodes[0]!;
    // The recorder consumes the sibling INSTEAD (ruling 9, zero extra config).
    expect(node.options.streams.left!.pipeId).toBe("camera/SL/raw12p/zlib");
    expect(node.options.streams.center!.pipeId).toBe("camera/SC/raw12p");
    expect(compress.log).toContain(
      "advertise:camera/SL/raw12p/zlib:BayerRG12p/zlib",
    );
    expect(compress.log).toContain("attach:camera/SL/raw12p->camera/SL/raw12p/zlib");
    // Ruling 8: the wrapped connect injects the JS-side significantBits for
    // BOTH the raw and the compressed pipes (the native spec drops it).
    const conn = node.options.connect("camera/SL/raw12p/zlib");
    expect(conn.spec.significantBits).toBe(12);
    const raw = node.options.connect("camera/SC/raw12p");
    expect(raw.spec.significantBits).toBe(12);
    await rec.stop();
    // Teardown order: brick detached + sibling unadvertised on stop.
    expect(compress.log).toContain("detach:camera/SL/raw12p/zlib");
    expect(compress.log).toContain("unadvertise:camera/SL/raw12p/zlib");
  });

  it("stop finalizes, releases, and notifies finished with the container path", async () => {
    const { deps, nodes, finished, registry } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    const dir = tmp();
    await rec.start(dir);
    expect(rec.active).toBe(true);
    await rec.stop();
    expect(rec.active).toBe(false);
    expect(nodes[0]!.stopped).toBe(true);
    expect(finished).toEqual([join(dir, "recording.fovea")]);
    expect(registry.refCount("camera/SL/raw12p")).toBe(0);
    // Idle-safe: a second stop is a no-op.
    expect(await rec.stop()).toBe(false);
  });

  it("evicts oldest dts entries past the bound (late descriptor → nulls, no stall)", async () => {
    const { deps, nodes } = makeDeps();
    const rec = createMultiFoveaRecording(deps);
    rec.onTargets([{ index: 0, enabled: true, streamId: 7 }]);
    await rec.start(tmp());
    const node = nodes[0]!;
    const onFrame = node.options.onFrame!;
    onFrame("left", 0, 1n);
    // Flood past the 96-entry bound — dts 1n evicts.
    for (let i = 1; i <= 100; i++) onFrame("left", i, BigInt(1000 + i));
    rec.onPairRecord(pairRecord(7, 1n, 999999n));
    rec.onTrackBatch(batch(5n, [0]));
    const { doc } = node.posted[0]!;
    expect(doc.frames.left).toBeNull(); // evicted → null pointer, never a stall
    await rec.stop();
  });

  it("a pair older than the freshness window degrades to free-run (null L/R)", async () => {
    // The round-robin schedule revisits each target far faster than
    // PAIR_FRESH_MS (1000 ms) in live trigger capture; a STALE pair must not
    // bind L/R pointers — the descriptor degrades to the free-run shape. Only
    // the fresh path was covered before.
    const nowSpy = vi.spyOn(performance, "now");
    try {
      const { deps, nodes } = makeDeps();
      const rec = createMultiFoveaRecording(deps);
      rec.onTargets([{ index: 0, enabled: true, streamId: 7 }]);
      await rec.start(tmp());
      const node = nodes[0]!;
      const onFrame = node.options.onFrame!;
      onFrame("left", 5, 100n);
      onFrame("right", 6, 200n);
      onFrame("center", 3, 150n);

      // Pair recorded at t=0, observed > PAIR_FRESH_MS later → stale → null L/R.
      nowSpy.mockReturnValue(0);
      rec.onPairRecord(pairRecord(7, 100n, 200n));
      nowSpy.mockReturnValue(1001);
      rec.onTrackBatch(batch(150n, [0]));
      expect(node.posted[0]!.doc.frames).toEqual({ left: null, center: 3, right: null });

      // A FRESH pair (same tick) binds the recorded L/R sequences.
      rec.onPairRecord(pairRecord(7, 100n, 200n));
      rec.onTrackBatch(batch(150n, [0]));
      expect(node.posted[1]!.doc.frames).toEqual({ left: 5, center: 3, right: 6 });
      await rec.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("releases every acquired raw pipe when the recorder node throws at start (retry clean)", async () => {
    // A throw during the acquire→build sequence (worker spawn / broker connect)
    // must retire compress bricks + release ALL acquisitions — else the orphaned
    // refcount never unadvertises (camera-exclusivity hazard) and a retry
    // double-refcounts. Assert refcounts return to zero and a retry succeeds.
    const { createNode } = fakeNodeFactory();
    let armed = true;
    const { deps, registry } = makeDeps({
      createNode: (opts) => {
        if (armed) {
          armed = false;
          throw new Error("boom: recorder worker spawn failed");
        }
        return createNode(opts);
      },
    });
    const rec = createMultiFoveaRecording(deps);
    await expect(rec.start(tmp())).rejects.toThrow("boom");
    // No orphaned refcounts — every acquired raw pipe was released.
    expect(registry.refCount("camera/SL/raw12p")).toBe(0);
    expect(registry.refCount("camera/SC/raw12p")).toBe(0);
    expect(registry.refCount("camera/SR/raw12p")).toBe(0);
    expect(rec.active).toBe(false);
    // A retry re-acquires cleanly (no double-refcount, node built).
    expect(await rec.start(tmp())).toBe(true);
    expect(registry.refCount("camera/SL/raw12p")).toBe(1);
    await rec.stop();
    expect(registry.refCount("camera/SL/raw12p")).toBe(0);
  });
});

describe("anchorExtras", () => {
  it("unpacks volts-only payloads without angle/affine", () => {
    const extras = anchorExtras(new Float64Array([1, 2, 3, 4]), "R");
    expect(extras).toEqual({
      volt: { x: 3, y: 4 },
      "volt.unit": "volt",
      "volt.source": "fin-averaged",
    });
  });

  it("rejects malformed payloads", () => {
    expect(anchorExtras(new Float64Array(2), "L")).toBeNull();
  });
});
