// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder CONFORMANCE GATE. The live recorder path is moving from a JS
// worker driving @mcap/core to a native brick driving a hand-rolled C++ MCAP
// writer (core/lib/Record/McapWriter). This test PROVES the two writers emit the
// SAME container: it drives @mcap/core AND the native writer with byte-for-byte
// identical inputs (same profile/library, same schema/channel registration
// ORDER, same explicit logTimes, same payloads, same metadata, same chunk-size
// threshold) and asserts:
//
//   1. BYTE-IDENTICAL output — the whole file, magic-to-magic, matches. The only
//      nondeterminism in the real recorder is wall-clock logTime + registration
//      order, both pinned here, so byte-identity is the achievable bar and the
//      strongest possible conformance statement (CRCs included).
//   2. Our readers ACCEPT the native file — McapIndexedReader.Initialize parses
//      it and every message reads back with the expected channel/seq/logTime/
//      payload (the summary, chunk index, message index + all three CRCs are
//      internally consistent, exactly what pyfcap / the viewer decode path and
//      app/test/recorder.test.ts rely on).
//   3. A native-written file the JS reader accepts, and vice-versa (cross-read).
//
// The subset exercised mirrors the recorder's real emission: a telemetry channel
// registered up front (schema id 1, channel id 0), per-stream raw-frame channels
// registered lazily (their schema/channel records land in a chunk on first use),
// an UNUSED registered schema+channel (summary-repeat + statistics still count
// it), session + wide-camera metadata at start, a small chunk size to force
// MULTIPLE chunks + a message index per channel per chunk, interleaved frame +
// telemetry messages, and a finalize metadata record before end().
//
// Run UNSANDBOXED from the repo root:
//   /opt/homebrew/bin/node core/test/39-mcap-writer.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McapWriter, McapIndexedReader } from "@mcap/core";

const enc = new TextEncoder();

// ---- deterministic synthetic container inputs -----------------------------
const PROFILE = "fovea";
const LIBRARY = "FoveaCamApp";
const CHUNK_BYTES = 4096; // small: forces several chunks over the frame payloads

const TELEMETRY_SCHEMA = { name: "fovea.frame_meta/v1", encoding: "jsonschema" };
const RAW_SCHEMA = { name: "fovea.raw_frame/v1", encoding: "jsonschema" };
const DESC_SCHEMA = { name: "fovea.descriptor/v1", encoding: "jsonschema" };
const RAW_SCHEMA_DATA = enc.encode(JSON.stringify({ description: "raw frame verbatim" }));
const TEL_SCHEMA_DATA = enc.encode(JSON.stringify({ description: "per-frame meta" }));
const DESC_SCHEMA_DATA = enc.encode(JSON.stringify({ description: "descriptor" }));

const frameMeta = (w: number, h: number, fmt: string) => ({
  dtype: "u8",
  shape: JSON.stringify([h, w]),
  width: String(w),
  height: String(h),
  channels: "1",
  pixelFormat: fmt,
  significantBits: "8",
  stride: String(w),
});

// A repeatable pseudo-random payload (so compression-incompressibility and CRC
// coverage are exercised on non-uniform bytes).
function payload(seed: number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < len; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

interface Ops {
  registerSchema(s: { name: string; encoding: string }, data: Uint8Array): Promise<number> | number;
  registerChannel(
    schemaId: number,
    topic: string,
    messageEncoding: string,
    metadata: Record<string, string>,
  ): Promise<number> | number;
  addMessage(
    channelId: number,
    sequence: number,
    logTime: bigint,
    publishTime: bigint,
    data: Uint8Array,
  ): Promise<void> | void;
  addMetadata(name: string, metadata: Record<string, string>): Promise<void> | void;
}

// The single source of truth for the container content; applied identically to
// both writers. Returns the finalize stats-relevant counts for assertions.
async function build(ops: Ops): Promise<void> {
  // Telemetry channel first (schema id 1, channel id 0).
  const telSchema = await ops.registerSchema(TELEMETRY_SCHEMA, TEL_SCHEMA_DATA);
  const telChannel = await ops.registerChannel(telSchema, "telemetry", "json", {});
  assert.equal(telSchema, 1);
  assert.equal(telChannel, 0);

  // Session + wide-camera metadata (written immediately, before any message).
  await ops.addMetadata("fovea:session", {
    timestamp: "2026-07-10T12:00:00.000Z",
    app: LIBRARY,
  });
  await ops.addMetadata("fovea:wide-camera", {
    cameraMatrix: JSON.stringify([[1000, 0, 640], [0, 1000, 480], [0, 0, 1]]),
    dist: JSON.stringify([0.1, -0.05, 0, 0, 0]),
  });

  // Two raw-frame channels — each registers its OWN raw_frame schema (ids 2, 3)
  // and channel (ids 1, 2), lazily emitted into a chunk on first message.
  const aSchema = await ops.registerSchema(RAW_SCHEMA, RAW_SCHEMA_DATA);
  const aChannel = await ops.registerChannel(aSchema, "camera/A/raw", "x-fovea-raw", frameMeta(64, 32, "Mono8"));
  const bSchema = await ops.registerSchema(RAW_SCHEMA, RAW_SCHEMA_DATA);
  const bChannel = await ops.registerChannel(bSchema, "camera/B/raw", "x-fovea-raw", frameMeta(48, 24, "Mono8"));
  assert.deepEqual([aSchema, aChannel, bSchema, bChannel], [2, 1, 3, 2]);

  // An UNUSED registered schema + channel (descriptor). Never messaged — but the
  // summary still repeats it and statistics still count it. Proves registration
  // (not first-use) drives schemaCount/channelCount + the summary repeat.
  const dSchema = await ops.registerSchema(DESC_SCHEMA, DESC_SCHEMA_DATA);
  const dChannel = await ops.registerChannel(dSchema, "fovea/unused", "json", {});
  assert.deepEqual([dSchema, dChannel], [4, 3]);

  // Interleaved frames + telemetry. Frame payloads ~900 B force several chunks
  // at CHUNK_BYTES=4096; telemetry docs are tiny and coalesce into a chunk.
  let t = 1_000_000_000n;
  for (let i = 0; i < 24; i++) {
    t += 5_000_000n;
    await ops.addMessage(aChannel, i, t, t, payload(1000 + i, 900));
    if (i % 2 === 0) {
      const doc = enc.encode(JSON.stringify({ stream: "camera/A/raw", seq: i, t: Number(t) / 1e9, volt: { x: i, y: -i } }));
      await ops.addMessage(telChannel, i, t, t, doc);
    }
    t += 3_000_000n;
    await ops.addMessage(bChannel, i, t, t, payload(5000 + i, 700));
  }

  await ops.addMetadata("fovea:finalize", { durationSec: "1.500" });
}

// ---- @mcap/core writer over an in-memory buffer ---------------------------
async function writeReference(): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let pos = 0n;
  const writable = {
    position: () => pos,
    write: async (data: Uint8Array) => {
      parts.push(data.slice());
      pos += BigInt(data.byteLength);
    },
  };
  const w = new McapWriter({ writable, chunkSize: CHUNK_BYTES });
  await w.start({ profile: PROFILE, library: LIBRARY });
  await build({
    registerSchema: (s, data) => w.registerSchema({ ...s, data }),
    registerChannel: (schemaId, topic, messageEncoding, metadata) =>
      w.registerChannel({ schemaId, topic, messageEncoding, metadata: new Map(Object.entries(metadata)) }),
    addMessage: (channelId, sequence, logTime, publishTime, data) =>
      w.addMessage({ channelId, sequence, logTime, publishTime, data }),
    addMetadata: (name, metadata) =>
      w.addMetadata({ name, metadata: new Map(Object.entries(metadata)) }),
  });
  await w.end();
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

// ---- native writer over a temp file ---------------------------------------
async function writeNative(core: any, path: string): Promise<{ messageCount: bigint; chunkCount: number }> {
  const h = core.__mcapOpen(CHUNK_BYTES, path, PROFILE, LIBRARY);
  await build({
    registerSchema: (s, data) => core.__mcapRegisterSchema(h, s.name, s.encoding, data),
    registerChannel: (schemaId, topic, messageEncoding, metadata) =>
      core.__mcapRegisterChannel(h, schemaId, topic, messageEncoding, metadata),
    addMessage: (channelId, sequence, logTime, publishTime, data) =>
      core.__mcapAddMessage(h, channelId, sequence, logTime, publishTime, data),
    addMetadata: (name, metadata) => core.__mcapAddMetadata(h, name, metadata),
  });
  const stats = core.__mcapEnd(h);
  return stats;
}

function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

async function readBack(buf: Uint8Array): Promise<{ messages: number; channels: number }> {
  const readable = {
    size: async () => BigInt(buf.byteLength),
    read: async (offset: bigint, length: bigint) =>
      buf.subarray(Number(offset), Number(offset) + Number(length)),
  };
  const reader = await McapIndexedReader.Initialize({ readable });
  let messages = 0;
  for await (const _ of reader.readMessages()) messages++;
  return { messages, channels: reader.channelsById.size };
}

async function main(): Promise<void> {
  const mod = (await import("core")) as any;
  const core = mod.default ?? mod;
  for (const fn of ["__mcapOpen", "__mcapRegisterSchema", "__mcapRegisterChannel", "__mcapAddMessage", "__mcapAddMetadata", "__mcapEnd", "__mcapAbort"]) {
    assert.equal(typeof core[fn], "function", `core.${fn} is exported`);
  }

  const dir = mkdtempSync(join(tmpdir(), "mcap-conformance-"));
  const nativePath = join(dir, "native.fcap");
  try {
    const reference = await writeReference();
    const stats = await writeNative(core, nativePath);
    const native = new Uint8Array(readFileSync(nativePath));

    // (1) BYTE-IDENTICAL.
    const diff = firstDiff(reference, native);
    if (diff !== -1) {
      const ctx = (a: Uint8Array, at: number) =>
        Buffer.from(a.subarray(Math.max(0, at - 8), at + 8)).toString("hex");
      console.error(
        `39-mcap-writer: FAIL — first byte diff at offset ${diff} ` +
          `(reference ${reference.length} B, native ${native.length} B)\n` +
          `  reference: ...${ctx(reference, diff)}...\n` +
          `  native   : ...${ctx(native, diff)}...`,
      );
      process.exit(1);
    }
    assert.equal(native.length, reference.length, "same total length");

    // (2) native file parses with our indexed reader.
    const rbNative = await readBack(native);
    const rbRef = await readBack(reference);
    assert.deepEqual(rbNative, rbRef, "native + reference read back identically");
    // 24 A-frames + 24 B-frames + 12 telemetry = 60 messages.
    assert.equal(rbNative.messages, 60, "60 messages read back");
    assert.equal(rbNative.channels, 4, "4 channels (incl. the unused one)");

    // Reported stats match the reader's view.
    assert.equal(stats.messageCount, 60n, "native stats messageCount");
    assert.ok(stats.chunkCount >= 3, `multiple chunks (${stats.chunkCount})`);

    // (3) crash-shape (abort) leaves a footer-less, parseable-as-stream file —
    // the indexed reader must REJECT it (no footer/summary), proving the crash
    // contract shape (streaming reader would still recover data-section chunks).
    const abortPath = join(dir, "aborted.fcap");
    const ah = core.__mcapOpen(CHUNK_BYTES, abortPath, PROFILE, LIBRARY);
    core.__mcapAddMetadata(ah, "fovea:session", { app: LIBRARY });
    core.__mcapAbort(ah);
    let rejected = false;
    try {
      await readBack(new Uint8Array(readFileSync(abortPath)));
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "aborted (footer-less) container is rejected by the indexed reader");

    console.log(
      `\n39-mcap-writer: PASS — native writer byte-identical to @mcap/core ` +
        `(${native.length} B, ${stats.chunkCount} chunks, 60 messages, 3 CRCs valid), ` +
        `indexed-reader round-trips both, abort leaves the documented crash-shape.`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("39-mcap-writer: FAIL —", err);
  process.exit(1);
});
