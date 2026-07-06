// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Source string for the recorder's worker_threads worker — eval'd CJS, the
// same pattern as `stream-writer.ts`'s WORKER_SOURCE: the orchestrator is
// bundled to a single file, so a separate worker source file would not exist
// at runtime. `@mcap/core` cannot be require()d by bare name from an eval
// worker (its `require` resolves against the process cwd, which is not the
// app directory in packaged builds) — the parent resolves the real entry
// path via `createRequire(import.meta.url)` and passes it in `workerData`.
//
// One McapWriter per worker, multiplexing every registered channel into one
// file. McapWriter is documented non-reentrant ("wait on any method call to
// complete before calling another"), so every operation — init, channel
// registration, frame/meta writes, finalize — is serialized through a single
// promise chain, exactly like `stream-writer.ts`'s `chain = chain.then(...)`.
// Message order on the port is preserved, so a "channel" registration posted
// before that channel's first "frame" is guaranteed to run first.
//
// Protocol: see `types.ts` (RecorderWorkerIn / RecorderWorkerOut).

export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { open } = require("node:fs/promises");
const { McapWriter } = require(workerData.mcapEntry);

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
      writer = new McapWriter({ writable, chunkSize: message.chunkBytes });
      await writer.start({ profile: "fovea", library: message.library });
      if (message.session) {
        await writer.addMetadata({
          name: "fovea:session",
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
            name: "fovea:finalize",
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
