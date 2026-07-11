// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Source string for the recorder sink's worker (eval'd CJS; the parent resolves the
// @mcap/core entry via createRequire and passes it in workerData). One McapWriter per
// worker, all channels into one file. Load-bearing: McapWriter is non-reentrant, so
// EVERY op is serialized through a single promise chain (chain = chain.then(...)); port
// message order is preserved so a channel registration runs before its first frame.
// spec: docs/spec/capture-recording.md#recorder-worker-source

import {
  FINALIZE_METADATA_NAME,
  FOVEA_PROFILE,
  SESSION_METADATA_NAME,
} from "./schema.js";

export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { open } = require("node:fs/promises");
const { McapWriter } = require(workerData.mcapEntry);
const FOVEA_PROFILE = ${JSON.stringify(FOVEA_PROFILE)};
const SESSION_METADATA_NAME = ${JSON.stringify(SESSION_METADATA_NAME)};
const FINALIZE_METADATA_NAME = ${JSON.stringify(FINALIZE_METADATA_NAME)};

let handle = null;
let writer = null;
let position = 0n;
let finalized = false;
const channelIds = new Map();
const encoder = new TextEncoder();
let chain = Promise.resolve();

// Minimal IWritable over a FileHandle (what @mcap/nodejs's FileHandleWritable
// does — inlined so @mcap/core stays the only promoted dependency).
const writable = {
  position: () => position,
  write: async (buffer) => {
    await handle.write(buffer);
    position += BigInt(buffer.byteLength);
  },
};

function post(message) {
  parentPort.postMessage(message);
}

function report(error) {
  post({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}

function enqueue(task) {
  chain = chain.then(task).catch(report);
}

function requireWriter() {
  if (!writer || finalized) throw new Error("recorder worker is not open");
  return writer;
}

parentPort.on("message", (message) => {
  if (message.type === "init") {
    enqueue(async () => {
      handle = await open(message.filePath, "w");
      // Bench-only (B-P4): compression is injected via message.compression and
      // lazy-required here, so production (which never sets it) ships no
      // compressor dependency and stays uncompressed — the B-4 default.
      let compressChunk;
      if (message.compression) {
        const c = message.compression;
        const fn = require(c.moduleEntry)[c.exportName];
        compressChunk = (chunkData) => ({
          compression: c.name,
          compressedData: fn(
            Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength),
            c.level,
          ),
        });
      }
      writer = new McapWriter({ writable, chunkSize: message.chunkBytes, compressChunk });
      await writer.start({ profile: FOVEA_PROFILE, library: message.library });
      if (message.session) {
        await writer.addMetadata({
          name: SESSION_METADATA_NAME,
          metadata: new Map(Object.entries(message.session)),
        });
      }
    });
  } else if (message.type === "channel") {
    enqueue(async () => {
      const w = requireWriter();
      const schemaId = await w.registerSchema({
        name: message.schema,
        encoding: "jsonschema",
        data: encoder.encode(message.schemaData),
      });
      const channelId = await w.registerChannel({
        schemaId,
        topic: message.name,
        messageEncoding: message.messageEncoding,
        metadata: new Map(Object.entries(message.metadata)),
      });
      channelIds.set(message.name, channelId);
    });
  } else if (message.type === "frame") {
    enqueue(async () => {
      const w = requireWriter();
      const channelId = channelIds.get(message.channel);
      if (channelId === undefined)
        throw new Error('recorder worker: unregistered channel "' + message.channel + '"');
      const data = new Uint8Array(message.data);
      await w.addMessage({
        channelId,
        sequence: message.seq,
        logTime: message.logTimeNs,
        publishTime: message.logTimeNs,
        data,
      });
      post({ type: "written", channel: message.channel, bytes: data.byteLength });
    });
  } else if (message.type === "meta") {
    enqueue(async () => {
      const w = requireWriter();
      const channelId = channelIds.get(message.channel);
      if (channelId === undefined)
        throw new Error('recorder worker: unregistered channel "' + message.channel + '"');
      await w.addMessage({
        channelId,
        sequence: message.seq,
        logTime: message.logTimeNs,
        publishTime: message.logTimeNs,
        data: encoder.encode(message.payload),
      });
    });
  } else if (message.type === "finalize") {
    enqueue(async () => {
      let stats = { messageCount: "0", chunkCount: 0, bytes: Number(position) };
      if (writer && !finalized) {
        finalized = true;
        if (message.session) {
          await writer.addMetadata({
            name: FINALIZE_METADATA_NAME,
            metadata: new Map(Object.entries(message.session)),
          });
        }
        await writer.end();
        const s = writer.statistics;
        await handle.close();
        stats = {
          messageCount: String(s ? s.messageCount : 0),
          chunkCount: s ? s.chunkCount : 0,
          bytes: Number(position),
        };
      }
      post({ type: "finalized", id: message.id, stats });
    });
  }
});
`;
