# Native recorder — hand-rolled C++ MCAP writer + recorder brick

Status: **ALL THREE WAVES SHIPPED** (2026-07-10): Wave 1 — the C++ MCAP writer
+ byte-identical conformance gate (core/test/39); Wave 2 — the RecorderStream
brick (producer-seam record taps + free-running writer thread, core/test/40);
Wave 3 — recorder-node.ts as a thin native driver (the JS worker/FIFO machinery
DELETED; churn soak + forced-zlib soak green). Rig pass owed (stage-f §Native
recorder). User-directed 2026-07-10.

::: details Why the JS recorder dropped frames — the four structural costs (motivation)

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
:::

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

**AS-SHIPPED — flat destination path (`5b539e9`, user ruling 2026-07-10):**
The container is now a single file named after the sequence directly inside
the save directory (`<seq>.fcap`), NOT `<seq>/recording.fcap`. The
recorder-node `path` option is the container path (`.fcap` appended unless
present); recording-service mkdirs the container's PARENT only — no
per-recording directory is created. Container layout above is unchanged;
this is purely the on-disk destination naming.

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

## Wave 2 — `core/lib/Record/RecorderStream.{h,cpp}` (SHIPPED)

A free-running native writer thread owning one `McapWriter`, fed brick→brick
from **record taps at the `Publisher::offer` seam** (`Pipe.h` `RecordTap`,
`Publisher::add/removeRecordTap`). NAPI surface: `core.Recorder.*`
(`core/src/Record.cpp`, handle registry; typed in `core/dist/index.d.ts`).

### Design delta vs the original sketch — the offer-seam tap

The sketch proposed per-brick OwnedFrame/stream taps (openRaw12pTap-style per
source kind, plus new plumbing for CompressStream outputs). Shipped instead:
ONE tap point at `Publisher::offer` — the seam **every** recorded source (raw
camera publishers, raw12p, CompressStream `/zlib` outputs, any derived brick)
already funnels through with EXACTLY the bytes the ring records (v5 opaque
payloads included). Rationale:
- **advert-verbatim by construction**: the tap sees the same `(data, FrameInfo,
  FrameMeta)` the seqlock write consumes, so a native-tapped recording is
  byte-for-byte what the JS FIFO reader would have read — zero per-source-kind
  plumbing, `/zlib` covered with NO broker extension;
- **still brick→brick**: it is an in-process producer-thread callback, not a
  ring read (the SHM-pipe-architecture invariant holds — rings remain IPC/JS
  boundaries only);
- **no Subscriber lifetime surface**: the recorder registers a plain callback
  slot, never a `Subscriber` — the Stream.h teardown rules (eject_all_and_drain
  / closes_in_flight_) are untouched by construction (tests 36/38 green), and
  `removeRecordTap` returns only after no in-flight tap invocation remains
  (the tap fires under the same mutex), so teardown is synchronous.
- The recorder still `connect()`s each pipe (refcount++ → C-21 gate) — the
  demand signal that runs the producer is unchanged; the ring write continues
  (shared with previews). Untapped pipes pay one relaxed atomic load per frame.

### As shipped

- **One recorder-added copy per frame**: the tap tight-packs the producer's
  (possibly strided) buffer straight into a POOLED queue-slot buffer on the
  producer thread (bounded, drop-oldest, never blocks capture; no per-frame
  allocation at steady state). The writer thread encodes from that slot
  (McapWriter's chunk assembly is the writer's own buffering — the role
  @mcap/core's chunk builder played, now in C++ with zlib CRC).
- **Drop contract**: per-stream bounded pending window (`maxQueuedFrames`,
  default 8). Overflow sheds the OLDEST queued frame of that stream:
  writer mid-encode → `droppedQueue`; writer between items → `droppedRing`.
  Invariants (pinned by core/test/40): `written + dropped == ingested`,
  `droppedQueue + droppedRing == dropped` — same shape `foldStreamStats` +
  the RecordButton hover pin. The old "ring lapped the reader" failure mode is
  structurally deleted (no ring read); `droppedRing` now names the
  burst-outran-the-drain case.
- **Timestamps (trusted-time)**: `logTime` = `Arv::steadyNowNs()` stamped on
  the producer thread at tap arrival (the single container axis — THE host
  time authority); `tNs` = the frame's TRUSTED `deviceTimestamp` forwarded
  verbatim through `FrameMeta` when the source stamps it, else the axis time.
  Never re-stamped. (The JS worker's clock had a different origin; the viewer
  windows on min/max logTime, so the origin is immaterial.)
- **Ruling-3 extras**: the brick buffers per-frame notices (bounded 4096,
  drop-oldest — extras are best-effort by contract) for `wantsExtras` streams;
  the host drains them via `takeNotices()` on its low-rate poll (out-of-loop —
  no TSFN, no per-frame JS) and posts extras back via
  `appendTelemetry(seq, logTimeNs, payloadJson)`, which rides the writer queue
  correlated by stream+seq with the OWNING frame's logTime — the
  `TELEMETRY_TOPIC` contract unchanged.
- **Metric block**: the writer thread owns a `Meter::ThreadMeter`
  (`Recorder.probe(handle)` → the standard brick snapshot); per-stream
  cumulative counters are atomics (`Recorder.stats(handle)`).
- **Lifecycle**: `create` (open container + session/wide-camera metadata +
  telemetry channel, spawn writer) / `addStream`/`removeStream` (synchronous
  tap attach/detach; an ENDED name re-added continues its channel + mcap
  sequence) / data channels (registered on the writer thread — present in the
  summary even with zero messages) / `finalize` = beginFinalize on the NAPI
  thread (detach every tap — the queue content IS the R-1 drain snapshot,
  enqueue the marker) + an AsyncTask awaiting the writer's completion /
  `abort` (crash-shape) / `destroy` (join + free; only after the finalize
  promise settles). All schema/metadata constants are passed IN from JS —
  docs/schema stays the single source of truth; C++ carries no fovea strings.
- **Gate**: `core/test/40-recorder-brick.ts` (out-of-process watchdog, tests
  36/38 pattern): full-feature recording + indexed-reader verification
  (channels incl. a zero-message data channel, counts == counters, verbatim
  metadata, contiguous sequences, telemetry round-trip), counter invariants,
  removeStream/re-add sequence continuity, abort crash-shape, 40× lifecycle
  churn (finalize|abort alternating).

## Wave 3 — orchestrator driver (SHIPPED)

`recorder-node.ts` is a thin native-brick driver with the SAME public surface
(`createRecorderNode` → `addStream`/`removeStream`/`addDataStream`/`postData`/
`stop`, `registerGraphWiring` + the workload meter, the extras dispatch).
`recording-service.ts` and every session composition are UNTOUCHED.

- **Deleted** (dead-code discipline): `WORKER_SOURCE`, `runStreamConsumer`,
  `StreamConsumerCfg`, `WorkerLike`, `WorkerStreamInit`, `RecorderNodeIn/Out`,
  the spawn/readerPath seams — the whole in-JS consume+encode worker.
- **Kept**: `foldStreamStats` + `StreamCounters` (the native brick exposes the
  identical counter shape), `dispatchFrame`/`ExtrasMessage` (the ruling-3
  dispatch, now posting to `appendTelemetry`), `SeqRead` (imported by
  capture-node.ts, whose bounded JS FIFO consumer legitimately remains),
  `channelMetadata` (NEW export: advert → verbatim channel metadata, the old
  `buildStreamInit` fields). `writer.ts` + `worker-source.ts` are KEPT as the
  `@mcap/core` reference the bench + `test/recorder.test.ts` container-contract
  suite drive.
- **Seams**: `native?: RecorderNative` (default: lazy `require("core").Recorder`
  — vitest injects a fake and never loads core) replaces `spawn`/`readerPath`.
- **Simplifications the brick buys**: `removeStream` releases its pipe
  IMMEDIATELY (tap detach is synchronous — the async `stream-ended` dance is
  gone); `stop()` = final notice drain → `native.finalize` raced against the
  R-2 deadline (expiry → `native.abort`, truncated stats, crash-shape file) →
  post-drain stats re-fold (so `stats()` counts the drain's tail frames) →
  `destroy` → release connections → retire meter + wiring.
- **/zlib**: zero new plumbing — the recorder connects the `/zlib` sibling pipe
  exactly as before and the offer-seam tap captures the compressed v5 payloads
  verbatim. Proven end-to-end by the multi-fovea soak (now pinned to
  `readMethod: () => "zlib"` — it previously read the machine's store config
  and silently degraded to raw on boxes without `record_compression=zlib`).
- **Gates**: vitest recorder-node suite rewritten over a fake native seam
  (794/794 total); `recorder-node-soak.ts` (real brick + fake-camera pipes,
  churn + descriptors + extras + exact accounting) and
  `multi-fovea-recording-soak.ts` (raw12p + REAL CompressStream + viewer-path
  decode) both green.

## Perf expectation (rig test — `docs/hardware/stage-f.md`)

Full-rate 3-camera recording sustains with **zero `droppedQueue`** (the original
defect): the write path is off the JS thread, does one copy per frame, and CRCs
in C++. Hover attribution (`droppedQueue` vs `droppedRing`) still resolves;
`finalize` under load drains cleanly; a crash mid-record leaves a footer-less
container the viewer's streaming reader recovers; `/zlib` streams record + decode;
OLD `.fovea`/`.fcap` recordings still open.

::: details Rig follow-up (2026-07-10): the real drop cause was the -O0 build, not the writer

The first rig recording after waves 1–3 still dropped hard (perf snapshot:
3×60 fps offered, 27.4 written/s, ~151 drops/s all `queue-overflow`, 85 MB/s to
disk against a measured 1.3 GB/s disk). Diagnosis chain: disk exonerated (dd at
frame-sized blocks), CRC exonerated (system libz, hardware crc32 at 15 GB/s), a
standalone -O2 emulation of the exact writer loop hit ~1,485 frames/s — then a
`sample` of the live writer showed the hot leaves were **per-byte
`std::vector` construct/destroy frames**. `core/CMakeLists.txt` had hardcoded
`set(CMAKE_BUILD_TYPE Debug)` with `-g` and NO `-O` since 2025-10-11: the entire
native core (this writer, every brick) had been compiling at -O0.

Fix: `CMAKE_CXX_FLAGS_DEBUG = "-O2 -g -DDEBUG"` (symbols kept for the crash
handler's backtraces; `DEBUG` kept — it only gates VERBOSE logging). Bench after:
**zero drops** at the same synthetic 3-stream load (~195 MB/s sustained, writer
idle-waiting). The optimization also exposed one REAL latent bug (timing-masked
at -O0): `Sub::Queue`/`Sub::Latest` `stop()` called `Subscriber<T>::close()` — a
QUALIFIED (static) call that bypassed the virtual `Queue::close` override, so a
consumer parked on a pending `next()` when JS called `return()` leaked its await
forever (deterministic test-36 wedge at -O2). Fixed by virtual dispatch
(`close(true, nullptr)`); test 36 now passes 3/3 in ~1 s (was ~30 s of churn).
:::

::: details Alternative considered: vendoring foxglove/mcap C++ (rejected for the writer; reader half earmarked)

Analyzed 2026-07-10 at the user's request, after waves 1–3 shipped. The official
C++ implementation (github.com/foxglove/mcap, MIT) is header-only
(`MCAP_IMPLEMENTATION` in one TU), vendorable, and its lz4/zstd deps are
compile-time optional (`MCAP_COMPRESSION_NO_LZ4/ZSTD`) — we write
`compression=""`, so integration would add zero dependencies. Technically easy;
rejected for the WRITER on three grounds:

1. **Byte-identity gate.** Test 39 pins our writer byte-for-byte against
   `@mcap/core`; the foxglove writer's output is valid-but-different MCAP
   (record ordering / statistics / chunk-builder policy), degrading the gate to
   structural round-trip — strictly weaker than what we have.
2. **The one-copy hot path.** `mcap::McapWriter`'s chunk builder buffers each
   message into its own chunk buffer — a per-frame memcpy the RecorderStream
   design specifically avoids (tap tight-packs once into a pooled slot; the
   writer appends straight from it).
3. **Footprint asymmetry on a frozen format.** ~8–10k vendored lines
   (reader+writer+types) vs our 719-line proven subset; the MCAP 1.x wire
   format is spec-stable, and the conformance gate catches drift regardless —
   "maintained upstream" buys ~nothing for writing.

**Earmarked for the future:** vendor the `McapReader` HALF when a native-read
use case lands (C++ playback brick, the viewer's non-hardware compute instance,
offline tooling) — it coexists with our writer by spec, and test 39 already
proves our files are `@mcap/core`-shaped, so the foxglove reader accepts them by
construction. Same trigger if in-container chunk compression (lz4/zstd:
better ratio + seekable chunks vs our per-frame `/zlib` payloads) is ever
wanted.
:::
