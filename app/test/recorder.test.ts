// MCAP recorder writer (B-5, docs/history/refactor/recorder-container.md §2 + §3):
// the fovea sink writes a single-file `.fovea` container (standard MCAP)
// through a worker_threads worker — validated here by writing synthetic
// frames and reading the file back with the real @mcap/core indexed reader
// (footer + chunk index present ⇒ the file finalized correctly). Bounded
// queue drop accounting and the channel→writer topology seam (sharding
// additive later) are asserted too.

import { mkdtemp, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { McapIndexedReader, type IReadable, type McapTypes } from "@mcap/core";
import {
  createFoveaSink,
  createRecordingSink,
  frameVoltageExtras,
  RECORDER_BACKEND,
  type RecorderTopology,
} from "@orchestrator/recorder";
import { createLegacySink } from "@orchestrator/recorder/legacy";
import { workloadsSnapshot } from "@orchestrator/metering";

const tmpRoots: string[] = [];

function fakeFrame(values = [1, 2, 3, 4]) {
  return Object.assign(new Uint16Array(values), {
    shape: [2, 2],
    channels: 1,
  }) as any;
}

function fakeU8Frame(values = [1, 2, 3, 4], channels = 1) {
  return Object.assign(new Uint8Array(values), {
    shape: [2, 2],
    channels,
  }) as any;
}

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "foveacam-recorder-"));
  tmpRoots.push(dir);
  return dir;
}

/** Minimal IReadable over a FileHandle (what @mcap/nodejs provides — inlined
 *  so @mcap/core stays the only app dependency). */
class HandleReadable implements IReadable {
  constructor(private readonly handle: FileHandle) {}
  async size(): Promise<bigint> {
    return BigInt((await this.handle.stat()).size);
  }
  async read(offset: bigint, length: bigint): Promise<Uint8Array> {
    const out = new Uint8Array(Number(length));
    await this.handle.read(out, 0, Number(length), Number(offset));
    return out;
  }
}

async function readContainer(path: string) {
  const handle = await open(path, "r");
  const reader = await McapIndexedReader.Initialize({ readable: new HandleReadable(handle) });
  const messages: McapTypes.Message[] = [];
  for await (const message of reader.readMessages()) messages.push(message);
  await handle.close();
  const topics = new Map(
    [...reader.channelsById.values()].map((c) => [c.topic, c] as const),
  );
  return { reader, messages, topics };
}

describe("MCAP recorder (fovea sink)", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("writes a finalized, index-seekable .fovea with raw channels + telemetry", async () => {
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
      writer: { chunkBytes: 1 }, // force chunk-per-message to assert chunking is live
    });

    const left0 = fakeFrame([10, 20, 30, 40]);
    sink.write("left-fovea", left0, "Mono12p", 1.0, { volt: { p: 0.5, t: -0.25 } });
    sink.write("left-fovea", fakeFrame([11, 21, 31, 41]), "Mono12p", 2.0, { volt: { p: 0.6, t: -0.2 } });
    sink.write("center", fakeFrame([5, 6, 7, 8]), "Mono16", 1.5, {}); // empty extras → no telemetry doc
    await sink.finalize(3.5);

    const file = join(dir, "recording.fovea");
    expect((await stat(file)).size).toBeGreaterThan(0);
    const { reader, messages, topics } = await readContainer(file);

    // channels: telemetry + one per stream, static decode props on the channel
    expect([...topics.keys()].sort()).toEqual(["center", "left-fovea", "telemetry"]);
    const left = topics.get("left-fovea")!;
    expect(left.messageEncoding).toBe("x-fovea-raw");
    expect(Object.fromEntries(left.metadata)).toMatchObject({
      dtype: "U16",
      shape: "[2,2]",
      channels: "1",
      pixelFormat: "Mono12p",
      significantBits: "12",
    });
    expect(Object.fromEntries(topics.get("center")!.metadata)).toMatchObject({
      pixelFormat: "Mono16",
      significantBits: "16",
    });

    // messages: 3 frames + 2 telemetry docs (center's empty extras skipped)
    expect(reader.statistics?.messageCount).toBe(5n);
    const leftFrames = messages.filter((m) => m.channelId === left.id);
    expect(leftFrames).toHaveLength(2);
    expect(leftFrames[0].logTime).toBe(1_000_000_000n);
    expect(leftFrames[0].sequence).toBe(0);
    expect(
      Array.from(new Uint16Array(leftFrames[0].data.slice().buffer)),
    ).toEqual([10, 20, 30, 40]);

    const telemetryId = topics.get("telemetry")!.id;
    const docs = messages
      .filter((m) => m.channelId === telemetryId)
      .map((m) => JSON.parse(new TextDecoder().decode(m.data)));
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({
      stream: "left-fovea",
      seq: 0,
      t: 1.0,
      volt: { p: 0.5, t: -0.25 },
    });

    // chunk ≈ 1 message with chunkBytes=1 — chunk index is real and per-frame
    expect(reader.chunkIndexes.length).toBe(5);

    // session metadata + per-dump README
    const metadata: McapTypes.Metadata[] = [];
    const handle = await open(file, "r");
    const r2 = await McapIndexedReader.Initialize({ readable: new HandleReadable(handle) });
    for await (const m of r2.readMetadata()) metadata.push(m);
    await handle.close();
    const names = metadata.map((m) => m.name);
    expect(names).toContain("fovea:session");
    expect(names).toContain("fovea:finalize");
    const finalize = metadata.find((m) => m.name === "fovea:finalize")!;
    expect(finalize.metadata.get("durationSec")).toBe("3.5");
    expect(await readFile(join(dir, "README.md"), "utf8")).toContain("MCAP");
  });

  it("carries the WS4 4b frame↔voltage binding in per-frame telemetry", async () => {
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z");

    // A recorded frame produced by CMD_FRAME capture 7 with its exposure-
    // averaged L-mirror voltage (built via the recorder's own schema helper).
    sink.write("left-fovea", fakeFrame([1, 2, 3, 4]), "Mono12p", 1.0, {
      ...frameVoltageExtras(7, { x: 1.25, y: -0.5 }),
      angle: { x: 0.01, y: -0.02 },
    });
    await sink.finalize(1.0);

    const { messages, topics } = await readContainer(join(dir, "recording.fovea"));
    const telemetryId = topics.get("telemetry")!.id;
    const doc = messages
      .filter((m) => m.channelId === telemetryId)
      .map((m) => JSON.parse(new TextDecoder().decode(m.data)))[0];
    expect(doc).toMatchObject({
      stream: "left-fovea",
      seq: 0,
      frame_id: 7, // stable capture identity from the FIN (B-12)
      volt: { x: 1.25, y: -0.5 }, // exposure-averaged voltage that produced it
      "volt.unit": "volt",
      "volt.source": "fin-averaged",
      angle: { x: 0.01, y: -0.02 },
    });
  });

  it("drops when the bounded queue is full and accounts them (stats + meter)", async () => {
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
      writer: { maxQueuedFrames: 1 },
    });

    // Synchronous burst: the first write occupies the single in-flight slot;
    // acks can't arrive between sync calls, so the rest MUST be refused.
    sink.write("overflow", fakeFrame([1, 1, 1, 1]), "Mono16");
    sink.write("overflow", fakeFrame([2, 2, 2, 2]), "Mono16");
    sink.write("overflow", fakeFrame([3, 3, 3, 3]), "Mono16");

    expect(sink.stats()).toMatchObject({
      overflow: { frames: 1, dropped: 2, bytes: 8 },
    });
    // metered from day one: drops are visible in the workload snapshot
    const meter = workloadsSnapshot()["recorder:recording.fovea"];
    expect(meter).toBeDefined();
    expect(meter.drops.byReason).toMatchObject({ backpressure: 2 });
    expect(meter.inputs["overflow"].count).toBe(1);

    await sink.finalize(1.0);
    // meter released with the writer
    expect(workloadsSnapshot()["recorder:recording.fovea"]).toBeUndefined();

    // only the accepted frame is in the container
    const { reader, messages, topics } = await readContainer(join(dir, "recording.fovea"));
    expect(reader.statistics?.messageCount).toBe(1n);
    expect(messages[0].channelId).toBe(topics.get("overflow")!.id);
    expect(
      Array.from(new Uint16Array(messages[0].data.slice().buffer)),
    ).toEqual([1, 1, 1, 1]);
  });

  it("routes streams through the topology seam (sharding stays additive)", async () => {
    const dir = await tempRoot();
    // A toy per-stream topology — proves the channel→writer mapping is a real
    // seam: swapping the topology shards files with zero sink/worker changes.
    const topology: RecorderTopology = {
      writerKeyFor: (stream) => stream,
      fileNameFor: (key) => `${key}.fovea`,
      initialWriterKeys: () => [],
    };
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", { topology });

    sink.write("a", fakeFrame([1, 2, 3, 4]), "Mono16", 1.0);
    sink.write("b", fakeFrame([5, 6, 7, 8]), "Mono12p", 1.0);
    await sink.finalize(1.0);

    for (const [name, format] of [
      ["a", "Mono16"],
      ["b", "Mono12p"],
    ] as const) {
      const { reader, messages, topics } = await readContainer(join(dir, `${name}.fovea`));
      expect(reader.statistics?.messageCount).toBe(1n);
      expect([...topics.keys()].sort()).toEqual([name, "telemetry"]);
      expect(topics.get(name)!.metadata.get("pixelFormat")).toBe(format);
      expect(messages[0].channelId).toBe(topics.get(name)!.id);
    }
  });

  it("uses pixel-format registry facts for static channel decode metadata", async () => {
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z");

    // The Mat's fallback channel count is deliberately stale; known formats
    // should publish the schema's channel/dtype facts instead.
    sink.write("rgb", fakeU8Frame([1, 2, 3, 4], 1), "RGB8", 1.0);
    await sink.finalize(1.0);

    const { topics } = await readContainer(join(dir, "recording.fovea"));
    expect(Object.fromEntries(topics.get("rgb")!.metadata)).toMatchObject({
      dtype: "U8",
      channels: "3",
      pixelFormat: "RGB8",
      significantBits: "8",
    });
  });

  it("keeps the legacy .stream/.meta/manifest backend intact behind the constant", async () => {
    // the default backend is the new container…
    expect(RECORDER_BACKEND).toBe("fovea");
    const facade = await createRecordingSink(await tempRoot(), "2026-07-06T00:00:00.000Z");
    expect(facade.kind).toBe("fovea");
    await facade.finalize(0);

    // …and the legacy sink still produces the exact pre-B-5 on-disk dump
    const dir = await tempRoot();
    const sink = await createLegacySink(dir, "2026-07-06T00:00:00.000Z");
    sink.write("left", fakeFrame([1, 2, 3, 4]), "Mono12p", 12.5, { tag: "sample" });
    await sink.finalize(2.25);

    const bytes = await readFile(join(dir, "left.stream"));
    expect(
      Array.from(new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)),
    ).toEqual([1, 2, 3, 4]);
    const lines = (await readFile(join(dir, "left.meta"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({
      o: 0,
      d: "U16",
      s: [2, 2],
      t: 12.5,
      f: "Mono12p",
      b: 12,
      x: { tag: "sample" },
    });
    const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      format: "FCRS",
      timestamp: "2026-07-06T00:00:00.000Z",
      duration: 2.25,
      streams: { left: { frames: 1, dropped: 0, bytes: 8 } },
    });
    expect((await readFile(join(dir, "__init__.py"), "utf8")).length).toBeGreaterThan(0);
    expect((await readFile(join(dir, "play"), "utf8"))).toContain("__init__.py");
  });
});
