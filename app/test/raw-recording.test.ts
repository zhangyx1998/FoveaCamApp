// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The generic raw-stream recording facility + the app-level
// `record_compression` routing. Everything injected — the recorder node
// factory, the raw-pipe registry seam, the compress seam, the broker, and the
// method reader — so the ROUTING DECISION (method "none" records raw, method
// "zlib" routes every stream through the per-frame /zlib sibling) and the
// significantBits injection are proven without native core or a worker thread.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createRawRecording,
  type RawRecordingDeps,
  type RawRecordingCamera,
} from "@orchestrator/raw-recording";
import { createRawPipeRegistry, type RawPipeSeam } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import type { RecordCompression } from "@orchestrator/record-compression";
import type { PipeBroker, PipeHandle } from "@orchestrator/pipe-session";
import type {
  RecorderNodeOptions,
  RecorderNodeHandle,
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

function fakeBroker(): PipeBroker {
  return {
    advertise: () => 1,
    unadvertise: () => {},
    connect: (pipeId: string): PipeHandle => ({
      shmName: `shm:${pipeId}`,
      spec: {
        pixelFormat: "BayerRG12p",
        dtype: "U16",
        width: 640,
        height: 480,
        channels: 1,
        bytesPerFrame: 640 * 480 * 2,
        stride: 640 * 2,
      },
    }),
    disconnect: () => 0,
  } as unknown as PipeBroker;
}

function fakeNodeFactory() {
  const nodes: Array<{ options: RecorderNodeOptions; stopped: boolean }> = [];
  const createNode = (options: RecorderNodeOptions): RecorderNodeHandle => {
    const node = { options, stopped: false };
    nodes.push(node);
    return {
      id: options.id,
      filePath: join(options.path, "recording.fovea"),
      stats: () => ({}),
      addStream: () => {},
      removeStream: () => {},
      addDataStream: () => {},
      removeDataStream: () => {},
      postData: () => {},
      stop: async () => {
        node.stopped = true;
        return { messageCount: "0", chunkCount: 0, bytes: 0 };
      },
    };
  };
  return { createNode, nodes };
}

// A 12p camera → the unpacked raw pipe is U16 with significantBits 12.
const camera = (serial: string): RawRecordingCamera => ({
  serial,
  pixel_format: "BayerRG12p",
  getFeatureInt: (n: string) => (n === "Width" ? 640 : 480),
});

function makeDeps(overrides: Partial<RawRecordingDeps> = {}) {
  const { registry } = fakeRegistry();
  const { createNode, nodes } = fakeNodeFactory();
  const broker = fakeBroker();
  const telemetry: unknown[] = [];
  const deps: RawRecordingDeps = {
    id: "recorder/test-app",
    broker,
    rawPipes: registry,
    streams: () => ({ left: camera("SL"), center: camera("SC"), right: camera("SR") }),
    finished: () => {},
    telemetry: (patch) => void telemetry.push(patch),
    createNode,
    readMethod: async (): Promise<RecordCompression> => "none",
    ...overrides,
  };
  return { deps, registry, nodes, telemetry };
}

const tmp = () => join(tmpdir(), `raw-rec-${Math.random().toString(36).slice(2)}`);

// --- tests -------------------------------------------------------------------

describe("raw recording facility — record_compression routing", () => {
  it("method 'none': records raw pipes verbatim, no compress brick", async () => {
    const compress = fakeCompress();
    const { deps, nodes, registry } = makeDeps({
      compress: compress.seam,
      readMethod: async () => "none",
    });
    const rec = createRawRecording(deps);
    expect(await rec.start(tmp())).toBe(true);
    const streams = nodes[0]!.options.streams;
    expect(streams.left!.pipeId).toBe("camera/SL/raw");
    expect(streams.center!.pipeId).toBe("camera/SC/raw");
    expect(streams.right!.pipeId).toBe("camera/SR/raw");
    // No brick advertised/attached.
    expect(compress.log).toEqual([]);
    expect(registry.refCount("camera/SL/raw")).toBe(1);
    // significantBits injected onto the raw connect (12p → 12).
    expect(nodes[0]!.options.connect("camera/SL/raw").spec.significantBits).toBe(12);
    await rec.stop();
    expect(registry.refCount("camera/SL/raw")).toBe(0);
  });

  it("method 'zlib': routes EVERY stream through its /zlib sibling", async () => {
    const compress = fakeCompress();
    const { deps, nodes } = makeDeps({
      compress: compress.seam,
      readMethod: async () => "zlib",
    });
    const rec = createRawRecording(deps);
    await rec.start(tmp());
    const streams = nodes[0]!.options.streams;
    expect(streams.left!.pipeId).toBe("camera/SL/raw/zlib");
    expect(streams.center!.pipeId).toBe("camera/SC/raw/zlib");
    expect(streams.right!.pipeId).toBe("camera/SR/raw/zlib");
    // Every stream advertised + attached its /zlib sibling on the source format.
    expect(compress.log).toContain("advertise:camera/SL/raw/zlib:BayerRG12p/zlib");
    expect(compress.log).toContain("attach:camera/SL/raw->camera/SL/raw/zlib");
    // significantBits injected for the compressed pipe too.
    expect(nodes[0]!.options.connect("camera/SL/raw/zlib").spec.significantBits).toBe(12);
    await rec.stop();
    // Teardown: bricks detached + siblings unadvertised.
    expect(compress.log).toContain("detach:camera/SL/raw/zlib");
    expect(compress.log).toContain("unadvertise:camera/SL/raw/zlib");
  });

  it("method 'zlib' but NO compress seam: degrades to raw (no throw)", async () => {
    const { deps, nodes } = makeDeps({ compress: undefined, readMethod: async () => "zlib" });
    const rec = createRawRecording(deps);
    await rec.start(tmp());
    expect(nodes[0]!.options.streams.left!.pipeId).toBe("camera/SL/raw");
    await rec.stop();
  });

  it("reads the method at each start (a config change applies to the NEXT recording)", async () => {
    let method: RecordCompression = "none";
    const compress = fakeCompress();
    const { deps, nodes } = makeDeps({
      compress: compress.seam,
      readMethod: async () => method,
    });
    const rec = createRawRecording(deps);
    await rec.start(tmp());
    expect(nodes[0]!.options.streams.left!.pipeId).toBe("camera/SL/raw");
    await rec.stop();
    // Change the config between recordings → the next start picks it up.
    method = "zlib";
    await rec.start(tmp());
    expect(nodes[1]!.options.streams.left!.pipeId).toBe("camera/SL/raw/zlib");
    await rec.stop();
  });
});
