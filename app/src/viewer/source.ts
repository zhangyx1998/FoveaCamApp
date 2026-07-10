// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `.fcap`/`.fovea` read layer for the STANDALONE viewer (standalone-viewer-
// and-fcap ruling 1): runs on the viewer window's own worker thread — never
// in the orchestrator (the C-8 viewer session retired with the ruling).
// Container format per docs/history/refactor/recorder-container.md §2b. One
// interface, two implementations:
//
// - **Indexed** (the normal path): `McapIndexedReader` over chunked async
//   `FileHandle` reads — seeks and time-range queries served by the chunk
//   index, no full-file scan.
// - **Streaming fallback** (footerless/crash-truncated files — the B-4
//   finding says readers MUST carry this): a sequential `McapStreamReader`
//   scan recovers every complete record that was flushed; the initial scan
//   collects channels + time bounds, and each `messages()`/`latestBefore()`
//   call rescans (O(file), acceptable for the crash-recovery edge case).
//   Sources opened this way report `truncated: true`.
//
// All file I/O is async `fs.FileHandle` reads in bounded chunks — nothing
// here blocks the worker's event loop for long stretches (playback pacing
// runs on the same thread); CPU work is just MCAP record parsing.
//
// Core-free and Vue-free: decode lives in `decode.ts`; this module moves
// bytes.

import { open, type FileHandle } from "node:fs/promises";
import {
  McapIndexedReader,
  McapStreamReader,
  type IReadable,
  type McapTypes,
} from "@mcap/core";
import { WIDE_CAMERA_METADATA_NAME } from "../../../docs/schema/fovea.js";

export interface FoveaChannel {
  id: number;
  topic: string;
  messageEncoding: string;
  metadata: Record<string, string>;
}

export interface FoveaMessage {
  channelId: number;
  /** Absolute log time (ns) as recorded — the §2b monotonic session clock. */
  logTime: bigint;
  data: Uint8Array;
}

export interface FoveaSource {
  readonly channels: readonly FoveaChannel[];
  /** Absolute log-time bounds of the recovered messages (equal when the file
   *  holds < 2 messages). */
  readonly startNs: bigint;
  readonly endNs: bigint;
  /** True = opened through the footerless streaming fallback. */
  readonly truncated: boolean;
  /** True when the container carries a `fovea:wide-camera` metadata record —
   *  the recorder declared a wide camera (viewer-timeline ruling 1). */
  readonly wideCameraDeclared: boolean;
  /** Messages in log-time order (file order for truncated sources — the
   *  writer emits in arrival order, so it's log-time-ordered per channel and
   *  near-ordered globally), filtered to `[startNs, endNs]` (absolute). */
  messages(opts?: {
    startNs?: bigint;
    endNs?: bigint;
    topics?: readonly string[];
  }): AsyncGenerator<FoveaMessage, void, void>;
  /** Latest message at-or-before `tNs` (absolute) per requested topic —
   *  the paused-scrub redraw query. Topics with no message ≤ tNs are absent
   *  from the result. */
  latestBefore(tNs: bigint, topics: readonly string[]): Promise<Map<string, FoveaMessage>>;
  /** First/last message ABSOLUTE log-time per channel topic — the timeline
   *  block spans (viewer-timeline §Blocks). Channels with no message are
   *  absent. Computed once at open (cheap seeks on the indexed path; one extra
   *  scan on the truncated path — the crash-recovery edge case). */
  channelSpans(): Promise<Map<string, { startNs: bigint; endNs: bigint }>>;
  /** Total message count per channel topic — the stats-popover message-count +
   *  average-fps stat. Cheap on the indexed path (the MCAP statistics summary's
   *  per-channel counts); one extra sequential scan on the truncated path. A
   *  topic absent from the result had no counted messages (or no statistics
   *  summary at all → the whole map is empty, and the UI shows "—"). */
  messageCounts(): Promise<Map<string, number>>;
  close(): Promise<void>;
}

/** Read chunk size for both the indexed reader's IReadable and the streaming
 *  scan — large enough to amortize syscalls, small enough to stay polite. */
const READ_CHUNK = 512 * 1024;

/** Reverse-scan cap for the indexed `latestBefore` — bounds a paused-scrub
 *  redraw on files where some requested channel is sparse or absent (without
 *  a cap, one missing channel would walk the whole file backwards). */
const LATEST_SCAN_CAP = 1024;

class HandleReadable implements IReadable {
  constructor(private readonly handle: FileHandle) {}
  async size(): Promise<bigint> {
    return BigInt((await this.handle.stat()).size);
  }
  async read(offset: bigint, length: bigint): Promise<Uint8Array> {
    const out = new Uint8Array(Number(length));
    let done = 0;
    // Chunked: a multi-MB chunk read lands as several bounded reads instead
    // of one giant buffer request.
    while (done < out.length) {
      const want = Math.min(READ_CHUNK, out.length - done);
      const { bytesRead } = await this.handle.read(out, done, want, Number(offset) + done);
      if (bytesRead <= 0) throw new Error("Unexpected EOF reading container");
      done += bytesRead;
    }
    return out;
  }
}

function toChannel(c: McapTypes.Channel): FoveaChannel {
  return {
    id: c.id,
    topic: c.topic,
    messageEncoding: c.messageEncoding,
    // Fold messageEncoding into the metadata record too — the contract's
    // ViewerChannel carries {name, metadata} only (pinned), and the UI needs
    // to tell json/telemetry tracks from x-fovea-raw frame tracks.
    metadata: { ...Object.fromEntries(c.metadata), messageEncoding: c.messageEncoding },
  };
}

// ---- indexed path ---------------------------------------------------------

class IndexedSource implements FoveaSource {
  readonly truncated = false;
  readonly channels: readonly FoveaChannel[];
  readonly startNs: bigint;
  readonly endNs: bigint;
  readonly wideCameraDeclared: boolean;

  constructor(
    private readonly handle: FileHandle,
    private readonly reader: McapIndexedReader,
  ) {
    this.channels = [...reader.channelsById.values()].map(toChannel);
    // Metadata INDEX carries record names in the summary — no body read needed.
    this.wideCameraDeclared = reader.metadataIndexes.some(
      (m) => m.name === WIDE_CAMERA_METADATA_NAME,
    );
    // Statistics carry the exact bounds when present; the chunk index is the
    // fallback ground truth (both are summary-section records).
    const stats = reader.statistics;
    if (stats && stats.messageCount > 0n) {
      this.startNs = stats.messageStartTime;
      this.endNs = stats.messageEndTime;
    } else if (reader.chunkIndexes.length > 0) {
      this.startNs = reader.chunkIndexes.reduce(
        (a, c) => (c.messageStartTime < a ? c.messageStartTime : a),
        reader.chunkIndexes[0].messageStartTime,
      );
      this.endNs = reader.chunkIndexes.reduce(
        (a, c) => (c.messageEndTime > a ? c.messageEndTime : a),
        reader.chunkIndexes[0].messageEndTime,
      );
    } else {
      this.startNs = 0n;
      this.endNs = 0n;
    }
  }

  async *messages(opts: {
    startNs?: bigint;
    endNs?: bigint;
    topics?: readonly string[];
  } = {}): AsyncGenerator<FoveaMessage, void, void> {
    for await (const m of this.reader.readMessages({
      startTime: opts.startNs,
      endTime: opts.endNs,
      topics: opts.topics,
    })) {
      yield { channelId: m.channelId, logTime: m.logTime, data: m.data };
    }
  }

  async latestBefore(
    tNs: bigint,
    topics: readonly string[],
  ): Promise<Map<string, FoveaMessage>> {
    const wanted = new Set(topics);
    const byTopic = new Map<number, string>(
      this.channels.filter((c) => wanted.has(c.topic)).map((c) => [c.id, c.topic]),
    );
    const out = new Map<string, FoveaMessage>();
    let scanned = 0;
    for await (const m of this.reader.readMessages({
      endTime: tNs,
      topics: [...wanted],
      reverse: true,
    })) {
      const topic = byTopic.get(m.channelId);
      if (topic && !out.has(topic))
        out.set(topic, { channelId: m.channelId, logTime: m.logTime, data: m.data });
      if (out.size >= wanted.size || ++scanned >= LATEST_SCAN_CAP) break;
    }
    return out;
  }

  async channelSpans(): Promise<Map<string, { startNs: bigint; endNs: bigint }>> {
    const out = new Map<string, { startNs: bigint; endNs: bigint }>();
    for (const c of this.channels) {
      // The chunk index serves both the first (forward) and last (reverse)
      // message of a topic with a single record pulled from each direction.
      let first: bigint | undefined;
      let last: bigint | undefined;
      for await (const m of this.reader.readMessages({ topics: [c.topic] })) {
        first = m.logTime;
        break;
      }
      if (first === undefined) continue; // channel carried no message
      for await (const m of this.reader.readMessages({ topics: [c.topic], reverse: true })) {
        last = m.logTime;
        break;
      }
      out.set(c.topic, { startNs: first, endNs: last ?? first });
    }
    return out;
  }

  async messageCounts(): Promise<Map<string, number>> {
    // Per-channel counts ride the statistics summary (id-keyed) — no body read.
    const counts = this.reader.statistics?.channelMessageCounts;
    const out = new Map<string, number>();
    if (!counts) return out; // no statistics summary → counts omitted (UI: "—")
    const topicById = new Map(this.channels.map((c) => [c.id, c.topic]));
    for (const [id, n] of counts) {
      const topic = topicById.get(id);
      if (topic) out.set(topic, Number(n));
    }
    return out;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

// ---- streaming fallback (footerless) --------------------------------------

/** Stream one sequential pass of the file through a fresh McapStreamReader,
 *  yielding each record as it parses (C-P7). Because it is an async generator,
 *  the caller pulls records one at a time — the `yield` applies natural
 *  backpressure, so a full-file playback of a large crash artifact never
 *  materializes the recovered messages into an array. A parse error on the
 *  truncated tail ends the pass (everything before it was recovered) — the B-4
 *  recovery story. Stops at DataEnd/Footer for a well-formed file. Early
 *  consumer break (`return()`) unwinds here without tripping the catch. */
async function* scanRecords(
  handle: FileHandle,
): AsyncGenerator<McapTypes.TypedMcapRecord, void, void> {
  const reader = new McapStreamReader({ validateCrcs: false });
  const buf = new Uint8Array(READ_CHUNK);
  let offset = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead <= 0) return;
      offset += bytesRead;
      reader.append(buf.subarray(0, bytesRead).slice());
      let record: McapTypes.TypedMcapRecord | undefined;
      while ((record = reader.nextRecord())) {
        if (record.type === "DataEnd" || record.type === "Footer") return;
        yield record;
      }
    }
  } catch {
    // Truncated/corrupt tail: every complete record already yielded is the
    // recovered content — stop cleanly.
    return;
  }
}

class TruncatedSource implements FoveaSource {
  readonly truncated = true;

  private constructor(
    private readonly handle: FileHandle,
    readonly channels: readonly FoveaChannel[],
    readonly startNs: bigint,
    readonly endNs: bigint,
    readonly wideCameraDeclared: boolean,
  ) {}

  static async open(handle: FileHandle): Promise<TruncatedSource> {
    const channels: FoveaChannel[] = [];
    let startNs: bigint | null = null;
    let endNs: bigint | null = null;
    let wideCamera = false;
    // The initial index pass must see the whole recovered stream (it needs
    // full time bounds), but retains only channels + min/max — not messages.
    for await (const record of scanRecords(handle)) {
      if (record.type === "Channel") {
        if (!channels.some((c) => c.id === record.id)) channels.push(toChannel(record));
      } else if (record.type === "Message") {
        if (startNs === null || record.logTime < startNs) startNs = record.logTime;
        if (endNs === null || record.logTime > endNs) endNs = record.logTime;
      } else if (record.type === "Metadata" && record.name === WIDE_CAMERA_METADATA_NAME) {
        wideCamera = true;
      }
    }
    return new TruncatedSource(handle, channels, startNs ?? 0n, endNs ?? 0n, wideCamera);
  }

  async *messages(opts: {
    startNs?: bigint;
    endNs?: bigint;
    topics?: readonly string[];
  } = {}): AsyncGenerator<FoveaMessage, void, void> {
    const ids = this.topicIds(opts.topics);
    // Stream records straight through the async scan (C-P7): one record in
    // flight at a time, so playing back a large crash artifact never buffers
    // the recovered messages into an array.
    for await (const record of scanRecords(this.handle)) {
      if (record.type !== "Message") continue;
      if (opts.startNs !== undefined && record.logTime < opts.startNs) continue;
      if (opts.endNs !== undefined && record.logTime > opts.endNs) continue;
      if (ids && !ids.has(record.channelId)) continue;
      yield {
        channelId: record.channelId,
        logTime: record.logTime,
        data: record.data,
      };
    }
  }

  async latestBefore(
    tNs: bigint,
    topics: readonly string[],
  ): Promise<Map<string, FoveaMessage>> {
    const ids = this.topicIds(topics)!;
    const topicById = new Map(
      this.channels.filter((c) => ids.has(c.id)).map((c) => [c.id, c.topic]),
    );
    const out = new Map<string, FoveaMessage>();
    for await (const record of scanRecords(this.handle)) {
      if (record.type !== "Message" || record.logTime > tNs || !ids.has(record.channelId))
        continue;
      // Sequential pass, keep-last: the final survivor per topic is the
      // latest ≤ tNs (bounded by topic count, not message count).
      out.set(topicById.get(record.channelId)!, {
        channelId: record.channelId,
        logTime: record.logTime,
        data: record.data,
      });
    }
    return out;
  }

  private topicIds(topics?: readonly string[]): Set<number> | null {
    if (!topics) return null;
    const wanted = new Set(topics);
    return new Set(this.channels.filter((c) => wanted.has(c.topic)).map((c) => c.id));
  }

  async channelSpans(): Promise<Map<string, { startNs: bigint; endNs: bigint }>> {
    const topicById = new Map(this.channels.map((c) => [c.id, c.topic]));
    const byId = new Map<number, { startNs: bigint; endNs: bigint }>();
    // One extra sequential scan (crash-recovery edge case), min/max per channel.
    for await (const record of scanRecords(this.handle)) {
      if (record.type !== "Message") continue;
      const cur = byId.get(record.channelId);
      if (!cur) byId.set(record.channelId, { startNs: record.logTime, endNs: record.logTime });
      else {
        if (record.logTime < cur.startNs) cur.startNs = record.logTime;
        if (record.logTime > cur.endNs) cur.endNs = record.logTime;
      }
    }
    const out = new Map<string, { startNs: bigint; endNs: bigint }>();
    for (const [id, span] of byId) {
      const topic = topicById.get(id);
      if (topic) out.set(topic, span);
    }
    return out;
  }

  async messageCounts(): Promise<Map<string, number>> {
    const topicById = new Map(this.channels.map((c) => [c.id, c.topic]));
    const byId = new Map<number, number>();
    // One extra sequential scan (crash-recovery edge case), tally per channel.
    for await (const record of scanRecords(this.handle)) {
      if (record.type !== "Message") continue;
      byId.set(record.channelId, (byId.get(record.channelId) ?? 0) + 1);
    }
    const out = new Map<string, number>();
    for (const [id, n] of byId) {
      const topic = topicById.get(id);
      if (topic) out.set(topic, n);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

// ---- entry ---------------------------------------------------------------

/** Open a `.fovea` container: indexed when the footer/summary is intact,
 *  streaming re-index fallback otherwise. */
export async function openFovea(path: string): Promise<FoveaSource> {
  const handle = await open(path, "r");
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: new HandleReadable(handle),
    });
    return new IndexedSource(handle, reader);
  } catch {
    // No/invalid footer or summary section — crash-truncated recording.
    return await TruncatedSource.open(handle);
  }
}
