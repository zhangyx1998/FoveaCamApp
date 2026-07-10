# Native recorder — hand-rolled C++ MCAP writer + recorder brick

Status: **Wave 1 SHIPPED (the C++ MCAP writer + conformance gate); Waves 2–3
DESIGNED (recorder brick + orchestrator driver).** User-directed 2026-07-10.

## Why — the live recorder drops frames the raw dump never did

The live recorder (`app/orchestrator/recorder-node.ts`) is ONE JS worker that
FIFO-consumes the named SHM pipes and hosts `@mcap/core` in-thread. It drops
frames at full-rate 3-camera recording that the old raw dump never dropped. The
structural costs, all on a single JS thread:

1. **Two full copies per frame** — the reused SHM read buffer → a fresh
   `ArrayBuffer` handed to the writer chain → `@mcap/core`'s chunk builder
   (`recorder-node.ts` `onFrame`: `new ArrayBuffer(view.byteLength); …set(view)`).
2. **JS CRC32** — `@mcap/core` computes chunk/data-end/summary CRCs in JS
   (`@foxglove/crc`) on the same thread that consumes the pipes.
3. **Chunk ≈ 1 raw frame framing** — every raw frame (≥ threshold) flushes its
   own chunk, so the per-frame path also does the chunk-index + message-index
   bookkeeping.
4. **One JS thread for all streams** — consume + copy + encode + CRC + write for
   every camera serialize behind one libuv thread; backpressure surfaces as ring
   `Gone` drops (`droppedQueue`).

Ruling (user, 2026-07-10): **implement hand-rolled MCAP I/O in C++.** A native
recorder path deletes the SHM-ring hop and the JS worker from recording: sources
are tapped brick→brick (OwnedFrame refs, no ring read), a free-running native
thread owns the writer, CRC is `zlib crc32()`, and one copy per frame lands
straight in the writer thread's chunk buffer.

## The on-disk contract is UNCHANGED

The container layout, channel/schema names, encodings, metadata records, and the
`.fcap` extension are exactly what the JS writer emits — so every existing reader
(the viewer decode path, `pyfcap`, and the `app/test/recorder.test.ts`
container-contract suite) accepts a native-written file identically, and OLD
recordings still open. The native writer targets `@mcap/core`'s **default
options** (the ones the JS recorder uses): `useChunks`, `useStatistics`,
`useSummaryOffsets`, `repeatSchemas`, `repeatChannels`, `useMessageIndex`,
`useChunkIndex`, `useMetadataIndex` all true; chunk `compression = ""`.

## Wave 1 — `core/lib/Record/McapWriter.{h,cpp}` (SHIPPED)

A hand-rolled, dependency-free (zlib only, already linked) MCAP writer. Byte
layout mirrored verbatim from `@mcap/core`'s `McapRecordBuilder.ts` +
`McapWriter.ts` + `ChunkBuilder.ts`. Little-endian throughout; strings are a
`u32` byte-length prefix + UTF-8; `Map<…>` fields are a `u32` byte-length prefix
+ packed pairs; every record is `opcode(u8) | length(u64 body-bytes) | body`.
Plain POSIX `write()` appends, never seeks back — the summary/footer are built
from in-memory index bookkeeping and appended at `end()`.

### Record subset emitted

| Record | Opcode | When | Notes |
|---|---|---|---|
| Magic | — | `open()` + after Footer | `89 4D 43 41 50 30 0D 0A` |
| Header | `0x01` | `open()` | `profile` = `fovea`, `library` = `FoveaCamApp` |
| Schema | `0x03` | lazily into a chunk on first message using it; repeated in summary | `RAW_FRAME`/`TELEMETRY`/`DESCRIPTOR` schema payloads verbatim |
| Channel | `0x04` | lazily into a chunk on first message; repeated in summary | topic = stream/channel name; metadata copied VERBATIM |
| Message | `0x05` | inside a chunk | payload written exactly as tapped (no unpack/header) |
| Chunk | `0x06` | when open chunk `> chunkSize` (message that crosses the threshold is included, then flush) | `compression=""`, `records` = uncompressed inner records |
| MessageIndex | `0x07` | one per channel present in the chunk, after the chunk | offsets are within the uncompressed chunk records |
| ChunkIndex | `0x08` | summary | one per finalized chunk |
| Statistics | `0x0B` | summary | counts below |
| Metadata | `0x0C` | data section, immediately | `fovea:session` + `fovea:wide-camera` at start; `fovea:finalize` before `end()` |
| MetadataIndex | `0x0D` | summary | one per metadata record |
| SummaryOffset | `0x0E` | summary tail | one per non-empty group |
| DataEnd | `0x0F` | end of data section | carries `dataSectionCrc` |
| Footer | `0x02` | after summary | carries `summaryCrc` |

Statistics accumulate exactly as `@mcap/core`: `messageCount` (u64),
`schemaCount` (u16, = number of `registerSchema` calls, even unused),
`channelCount` (u32, = `registerChannel` calls), `attachmentCount=0`,
`metadataCount`, `chunkCount`, `messageStartTime`/`messageEndTime` (min/max
`logTime`), and `channelMessageCounts` (`Map<u16,u64>`, **insertion order = order
a channel first gets a message**, not id order). Schema ids start at 1, channel
ids at 0; the summary repeats **all registered** schemas/channels (id-sorted ==
registration order), even ones no message used.

### CRC fields — which, and over what (all `zlib crc32()`)

CRC-32/ISO-HDLC (poly `0xEDB88320` reflected, init `0xFFFFFFFF`, xorout
`0xFFFFFFFF`) — `zlib crc32(0, …)` is byte-identical to `@foxglove/crc` and
chains the same way (each accumulator holds the finalized-so-far value).

| CRC field | Record | Covers |
|---|---|---|
| `uncompressedCrc` | Chunk | the raw **uncompressed** inner records region (schemas/channels/messages), one-shot; never 0 |
| `dataSectionCrc` | DataEnd | every byte from the leading magic through the last data-section record (chunks + message indexes + metadata), i.e. `[0, DataEnd)`; never 0 |
| `summaryCrc` | Footer | `[summaryStart, summaryOffsetStart)` (repeated schemas + channels + statistics + metadata index + chunk index + summary offsets) **plus** the 25-byte footer prefix (`opcode + length(20) + summaryStart + summaryOffsetStart`), excluding the crc field itself + trailing magic |

`/zlib` payload compression is UPSTREAM (`CompressStream`) and rides as payload
bytes with the `/zlib` format suffix in the channel `pixelFormat` metadata — the
recorder never sets MCAP chunk compression (stays `""`), exactly as today.

### Conformance — BYTE-IDENTICAL (`core/test/39-mcap-writer.ts`)

The gate drives `@mcap/core` AND the native writer with byte-for-byte identical
inputs (same profile/library, same schema/channel registration ORDER, same
explicit `logTime`s, same payloads, same metadata, same `chunkSize`) and asserts
the **whole file is byte-identical, magic-to-magic, CRCs included**. Because the
only nondeterminism in the real recorder is the wall-clock `logTime` and
registration order — both pinned here — byte-identity is the achievable bar and
the strongest possible conformance statement.

The exercised subset mirrors real emission: telemetry channel registered up
front (schema 1 / channel 0), two raw-frame channels registered lazily (their
records land in a chunk on first use), an UNUSED registered schema+channel
(summary-repeat + statistics still count it), session + wide-camera metadata at
start, a small `chunkSize` forcing **10 chunks**, interleaved frame + telemetry
messages (60 total), and a `fovea:finalize` metadata before `end()`.

Result (as shipped): **byte-identical, 46186 B, 10 chunks, 60 messages, 3 CRCs
valid.** `McapIndexedReader.Initialize` round-trips both the native and the
reference file identically (proving the summary/chunk index/message index + all
three CRCs are internally consistent — what pyfcap and the viewer rely on). The
`abort()` (crash-shape) file — footer-less — is REJECTED by the indexed reader,
confirming the documented crash contract (a streaming/re-index reader recovers
the data-section chunks).

### NAPI surface (test-only)

`__mcap{Open,RegisterSchema,RegisterChannel,AddMessage,AddMetadata,End,Abort}`
root exports (`core/src/Record.cpp`, handle-indexed registry) exist ONLY to let
test 39 drive the native writer from JS. The live recorder brick drives
`Record::McapWriter` directly in C++ — **no NAPI per frame.** These are not in
the public `.d.ts` (same pattern as `__streamTeardownRaceSelfTest`).

## Wave 2 — `core/lib/Record/RecorderStream.{h,cpp}` (DESIGNED)

A free-running native writer thread owning one `McapWriter`, fed by per-source
bounded queues. Follows the `CompressStream`/`CompressRunner` precedent (a gated
private thread that touches nothing NAPI/registry) and the SHM-pipe-architecture
invariant (brick→brick = OwnedFrame/stream taps, never a ring read).

- **Sources subscribe brick→brick.** The brick taps the SAME streams whose SHM
  pipes the JS recorder consumed: raw camera publisher sources (`openRaw12pTap`
  precedent), `CompressStream` outputs (for `/zlib` recording — tap the compress
  output STREAM, not its pipe; extend the broker surface minimally so the source
  stream is reachable, mirroring how `attachCompressPipe` resolves a source
  Publisher), derived bricks. Follow `StereoStream`'s `RecordSink` drop-oldest
  tap.
- **One copy max per frame.** Hold the `OwnedFrame::Ptr`/`ConvertedFrame` ref in
  the queue slot and write straight from it into the writer thread's chunk
  buffer (`McapWriter::addMessage(payload)` copies once, into `chunk_`). Zero
  extra `ArrayBuffer`.
- **Bounded per-channel queue.** Writer-busy overflow = queue-attributed drop;
  tap-side drop-oldest overwrite = ring-attributed drop. Same
  `droppedQueue`/`droppedRing` split as the JS path (`backpressured` flag).
- **Metric block.** Each writer thread exposes the standard `Meter::ThreadMeter`
  profiling block the orchestrator probes out-of-loop; cumulative per-stream
  counters `{ingested, dropped, droppedQueue, droppedRing, written, bytes}` in
  the SAME shape `recorder-node.ts`'s `StreamCounters` + `foldStreamStats`
  expect, so the orchestrator folding + RecordButton hover attribution keep
  working UNCHANGED.
- **Per-frame telemetry/extras (ruling-3).** A NAPI `appendTelemetry(stream,
  seq, logTimeNs, payloadJson)` enqueues a telemetry message onto the writer
  queue, correlated by stream+seq exactly like today's `TELEMETRY_TOPIC`
  messages. The JS-visible contract from `recorder-node.ts` (dispatch a frame
  notice → session callback returns extras → post back) is preserved; only the
  worker boundary becomes a native enqueue.
- **Timestamps.** `logTime` = the frame's TRUSTED `deviceTimestamp` (device time
  when the source stamps it) else the publish/monotonic time, computed exactly as
  the JS path does — never re-stamped (trusted-time invariant).
- **Lifecycle.** `start(filePath, sessionMeta)` / `finalize()` (drain queues to a
  snapshot target, write summary, close — R-1 drain semantics) / `abort()`
  (crash-shape file). MUST follow `Stream.h` teardown lifetime rules
  (`eject_all_and_drain`, `closes_in_flight_`; tests 36/38 stay green). The
  recorder holds no hardware, so janitor/quiescence is unaffected.

## Wave 3 — orchestrator driver (DESIGNED)

`recorder-node.ts`'s HOST becomes a thin native-brick driver with the SAME public
surface (`createRecorderNode` → `addStream`/`removeStream`/`addDataStream`/
`postData`/`stop`, `registerGraphWiring`, the stats-folding timer, the telemetry
extras dispatch). `recording-service.ts` and every session composition stay
UNCHANGED. The FIFO/worker machinery (`WORKER_SOURCE`, `runStreamConsumer`) is
SUPERSEDED and DELETED (dead-code discipline) — the pure exported functions the
vitest suites pin (`foldStreamStats`, `dispatchFrame`, `StreamCounters` shape)
are KEPT (they still describe the native counter fold + the ruling-3 dispatch).
`writer.ts` + `worker-source.ts` are KEPT as the `@mcap/core` reference the
conformance bench/container-contract tests drive. `record_compression=zlib`
routing keeps working: the brick taps the `CompressStream` output stream instead
of its `/zlib` sibling pipe.

## Perf expectation (rig test — `docs/hardware/stage-f.md`)

Full-rate 3-camera recording sustains with **zero `droppedQueue`** (the original
defect): the write path is off the JS thread, does one copy per frame, and CRCs
in C++. Hover attribution (`droppedQueue` vs `droppedRing`) still resolves;
`finalize` under load drains cleanly; a crash mid-record leaves a footer-less
container the viewer's streaming reader recovers; `/zlib` streams record + decode;
OLD `.fovea`/`.fcap` recordings still open.
