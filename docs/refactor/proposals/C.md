# Coder C optimization proposals

Ranked survey of the C-owned SHM frame path, metering core, and viewer data layer.

## C-P1 — One frame descriptor/meta normalizer

- **Locations:** `core/src/ShmRing.cpp` (`WriterCore::descriptor`), `app/electron/preload-renderer.ts` (`readShmFrame`), `app/lib/orchestrator/client.ts` (`materializeFramePayload` / source stamping), `app/orchestrator/frame-transport.ts` (`normalizeFrame`), `app/test/fake-frame-transport.ts`.
- **Current -> proposed:** each layer hand-merges `shape`, `channels`, `meta`, and `shm` slightly differently -> introduce a small shared `frame-payload` helper for `mergeFrameMeta`, `withShmResult`, `byteLength`, and `cloneDescriptor` semantics; native stays as producer, JS layers use one merge policy.
- **Category:** non-breaking.
- **Rationale:** there are at least 5 merge sites on the hot descriptor path, and prior V9/V13 bugs were exactly "metadata/payload looks valid but came from the wrong place/runtime." One helper makes meta precedence and `shm.retries/gen/seq` updates reviewable in one file.
- **Effort:** M.
- **Risk:** medium; the helper would sit in shared renderer/orchestrator code, so it must stay Vue-free and core-free except for type-only imports.

## C-P2 — Factor the renderer SHM transfer pool out of `client.ts`

- **Locations:** `app/lib/orchestrator/client.ts`, `app/electron/preload-renderer.ts`.
- **Current -> proposed:** `client.ts` owns Vue session binding, perf snapshot shortcuts, frame coalescing, and ~100 lines of SHM ping-pong pool state -> move pool state and message types to `app/lib/orchestrator/shm-client.ts` (or equivalent) with a small API: `read(payload)`, `release(payload)`, `dispose()`, stats.
- **Category:** non-breaking.
- **Rationale:** `client.ts` is doing unrelated jobs; the pool has its own lifecycle, timeout, recycling, and message protocol. Isolation lowers the chance that future session-client edits break the cage-safe path.
- **Effort:** M.
- **Risk:** medium; MessagePort transfer ownership is easy to regress, so tests need to pin buffer return on success, null, timeout, and stale response.

## C-P3 — Share cumulative window/rate bookkeeping

- **Locations:** `app/orchestrator/metering.ts`, `app/lib/orchestrator/protocol.ts` (`allFrameStats`), profiler workload transforms as consumer context.
- **Current -> proposed:** Channel frame stats and Workload snapshots each build `{startedAt,snapshotAt,uptimeMs}` and divide cumulative counters by uptime -> add a Vue-free `CumulativeWindow`/`rateSnapshot` helper under `app/lib/util` or `app/orchestrator` with explicit `now` injection.
- **Category:** non-breaking.
- **Rationale:** 2 independent implementations of the same T10 lineage already exist; every new perf citizen will otherwise copy the same `Math.max(1, now-start)` pattern and risk drifting from profiler expectations.
- **Effort:** S.
- **Risk:** low; keep the output shape unchanged.

## C-P4 — Move SHM reader-side layout/open/read validation into shared native code

- **Locations:** `core/include/ShmRing.h`, `core/src/ShmRing.cpp`, `core/reader/ShmReaderAddon.cpp`.
- **Current -> proposed:** the reader addon duplicates mapping, header validation, slot addressing, and seqlock read logic from the writer-side substrate -> expose a small libc-safe `ReadMapping`/`readLatestInto` implementation compiled into both the core target and the reader addon.
- **Category:** non-breaking.
- **Rationale:** V8 and V9 were seqlock/read-window defects; duplicating the hard memory-ordering logic across targets makes future fixes easy to apply to only one side. One C++ implementation keeps fences, meta copy timing, retry cap, and header validation together.
- **Effort:** M.
- **Risk:** medium; the reader addon must remain system-library-only, so the shared implementation must not pull in N-API helpers, OpenCV, Aravis, GLib, or libusb.

## C-P5 — Make cage semantics impossible to misuse

- **Locations:** `core/dist/Shm/index.d.ts`, `core/src/ShmRing.cpp`, `app/orchestrator/frame-transport.ts`, registry tap path.
- **Current -> proposed:** `ShmSlot.view()` still sounds like a live writable view even though Electron returns a read snapshot under the V8 cage -> add `readSnapshot()` as the preferred name, keep `view()` as a deprecated alias, and steer call sites to `write()` / `copyTo()` / `readSnapshot()` terminology.
- **Category:** non-breaking now; breaking later if `view()` is removed.
- **Rationale:** V13 happened because the API name invited `view().set(...)`; the d.ts warning helps, but the method name still points future coders at the wrong mental model.
- **Effort:** S.
- **Risk:** low for aliasing; medium only if a later cleanup removes `view()`.

## C-P6 — Single decode schema for TS viewer, pyfovea, and legacy decoder lineage

- **Locations:** `app/orchestrator/viewer/decode.ts`, `app/lib/util/dtype.ts`, `app/orchestrator/stream-decoder.py`, `pyfovea/src/pyfovea/dtypes.py`, recorder channel metadata in `app/orchestrator/recorder/index.ts` (B-owned).
- **Current -> proposed:** dtype tables, significant-bit rules, Bayer patterns, and 12p semantics live in at least 4 files across TS and Python -> introduce a versioned schema fixture, e.g. `docs/schema/fovea-frame-codec.json`, with generated TS/Python tables or conformance tests in both languages.
- **Category:** non-breaking if added as tests/helpers; breaking only if metadata names change.
- **Rationale:** the recorder contract depends on exact decode props; drift between viewer display and pyfovea training decode would be hard to spot visually and expensive after recordings exist.
- **Effort:** M.
- **Risk:** medium; cross-role with B, and generation must not add a runtime dependency to orchestrator startup.

## C-P7 — Stream truncated viewer playback without collect-then-yield

- **Locations:** `app/orchestrator/viewer/source.ts` (`TruncatedSource.messages`).
- **Current -> proposed:** crash-truncated `messages()` scans then stores every selected message in an array before yielding -> implement an async iterator bridge that yields records as the scan progresses, or build a lightweight recovered offset index once at open.
- **Category:** non-breaking.
- **Rationale:** the file comments promise bounded reads, but the fallback can buffer the entire selected recovered range; a large crash artifact could put viewer recovery memory on the orchestrator process.
- **Effort:** M.
- **Risk:** medium; `McapStreamReader.nextRecord()` is synchronous per appended chunk, so the async generator bridge needs careful backpressure/error semantics.

## C-P8 — Detect or eliminate SHM topic-key collisions

- **Locations:** `core/src/ShmRing.cpp` (`topicKeyFor`), `core/test/08-shm-ring.ts`, per-topic writers in `app/orchestrator/frame-transport.ts`.
- **Current -> proposed:** `topicKey` is base36 FNV-1a 32-bit; tests cover representative uniqueness but collisions are still silent -> move to a longer hash that still fits `PSHMNAMLEN`, or add a process-local collision registry that throws before two live topics share a key.
- **Category:** non-breaking for longer internal names; potentially breaking if external tooling assumes exact segment names.
- **Rationale:** dynamic viewer/capture topics can grow quickly; a hash collision would cross-wire pixel rings while descriptors still look valid.
- **Effort:** S.
- **Risk:** low to medium; macOS' 31-char limit leaves little name budget, so test the worst-case generation suffix.

## C-P9 — Add explicit SHM read/pool telemetry

- **Locations:** `app/lib/orchestrator/client.ts`, proposed SHM pool module from C-P2, `app/src/components/StreamView.vue`, `app/orchestrator/metering.ts` as schema consumer.
- **Current -> proposed:** StreamView shows per-frame retries/generation, and failures only hit `console.error`; pool timeouts, stale responses, buffer allocations, and read latency are not first-class -> expose a small `shmReads` workload/stat block and OSD fields for timeout/null/allocation counts.
- **Category:** non-breaking.
- **Rationale:** PB2 will judge the SHM path, but the renderer-side copy/read pool currently has less visibility than Channel or Workload stats. The first live display issue will otherwise require ad hoc console tracing.
- **Effort:** M.
- **Risk:** low; meters must observe only and never gate reads.

## C-P10 — Shorten C-owned API names where the local style supports it

- **Locations:** `app/lib/orchestrator/client.ts`, `app/orchestrator/metering.ts`, `app/orchestrator/viewer/source.ts`, `app/orchestrator/viewer/player.ts`.
- **Current -> proposed:** rename map, staged through aliases where exported: `materializeFramePayload` -> `materializeFrame`, `readShmFrameViaTransfer` -> `readShm`, `releaseShmPayload` -> `releaseFrameBuffer`, `allWorkloadSnapshots` -> `workloadsSnapshot`, `workloadSnapshot` -> `snapshotWorkload`, `latestBefore` -> `latestAtOrBefore`, `publishTelemetry` -> `emitTelemetry`.
- **Category:** breaking if done directly; non-breaking if aliases land first and call sites migrate.
- **Rationale:** these names are precise but wordier than nearby project style (`topic`, `frame`, `emit`, `snapshot`). Shorter names reduce line wrapping in the already-dense client/viewer code.
- **Effort:** S.
- **Risk:** low for internal names; medium for exported metering/source APIs because tests and A/B call sites may import them.

## C-P11 — Make viewer file opens path-idempotent in the session layer

- **Locations:** `app/orchestrator/sessions/viewer.ts`, `app/lib/orchestrator/viewer-contract.ts`.
- **Current -> proposed:** every `open(path)` allocates a new fileId/source/player even if the same path is already open; window manager dedupes at the shell layer, but the session contract does not -> return the existing fileId for the same canonical path, with optional refcount only if multiple clients really need independent close semantics.
- **Category:** breaking if `open()` is expected to create independent playback instances; non-breaking if documented as dedupe and no caller relies on duplicates.
- **Rationale:** duplicate opens double file readers, workload meters, decoder caches, and shm topics for the same recording; the product spec says one viewer window per file.
- **Effort:** M.
- **Risk:** medium; close semantics and multi-window restore need planner/A coordination.

## C-P12 — Make future non-8-bit frame payloads explicit instead of inferred

- **Locations:** `app/lib/orchestrator/protocol.ts`, `app/lib/orchestrator/client.ts` (`frameByteLength`), `app/orchestrator/frame-transport.ts`.
- **Current -> proposed:** `FramePayload` byte length is inferred as `shape product * channels`, which is correct for canonical display `Uint8` payloads -> if raw/capture/12-bit SHM is later dispatched, add explicit `byteLength`/`dtype`/`pixelFormat` to the descriptor before widening scope.
- **Category:** breaking for the payload contract if adopted.
- **Rationale:** Stage 4 explicitly excludes raw/capture/12-bit frames; the current shape-only descriptor will be a trap if reused for packed or 16-bit data because buffer sizing would silently under-allocate.
- **Effort:** M.
- **Risk:** high if done prematurely; best treated as a gate for a future raw-frame transport dispatch, not as cleanup now.
