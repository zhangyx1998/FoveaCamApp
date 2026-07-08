# Coder C optimization proposals — ROUND 2 (post wave-2)

Re-survey of the C-owned surface after wave-2 landed `shm-client.ts` (pool
extraction), the shared `ShmRead` native TU (C-P4), streaming truncated
playback (C-P7), `shmReads` telemetry (C-P9), viewer open-dedupe (C-P11), and
the decode-conformance suite (C-P6). Focus per dispatch: duplication the
extractions *didn't* reach, wordy names, and better-fit structures the new
module boundaries now enable. Ranked by value. C-P12 (explicit byteLength/dtype
in FramePayload) is NOT re-proposed — still gated on a future raw/16-bit shm
dispatch; P-items below reference it where adjacent.

---

## C-R2-P1 — Unify `shmReads` onto the shared stats lineage + one sample-stats type

- **Locations:** `app/lib/orchestrator/shm-client.ts` (`ShmReadStats`,
  `ShmLatencyStats`, the `latSum/latCount/latMax` accumulator), consuming
  `app/lib/orchestrator/stats.ts`; ref `app/orchestrator/metering.ts` and
  `protocol.ts` `FrameTopicStats` as the existing citizens of that lineage.
- **Current → proposed:** `shm.stats()` emits RAW cumulative counters
  (reads/nulls/timeouts/errors/allocations/poolHits) with **no rates**, plus a
  hand-rolled latency accumulator producing `{count,mean,max}`. Meanwhile
  `metering.ts` and Channel frame-stats both derive rates from `stats.ts`
  (`snapshotWindow`/`counterRate`). → Give the pool a `createdAt`, express the
  counters as `CounterRate` via `stats.ts`, and type latency as a **shared
  `SampleStats {count,mean,max}`** reused from `protocol.ts`'s
  `FrameTimingStats` (byte-identical shape today — see P-note). `shmReads`
  becomes the third citizen of the C-P3 window/rate lineage instead of a
  parallel one.
- **Category:** non-breaking (additive fields; existing keys unchanged; all
  renderer-safe — `stats.ts` is already `@lib/orchestrator`).
- **Rationale:** the extractions unified the *window/rate* math once (C-P3) but
  `shmReads` (C-P9) was built just after and never adopted it — a 3rd counter
  lineage. PB2 will judge the SHM path and wants reads/sec + timeouts/sec,
  which the raw block can't answer; and `ShmLatencyStats` duplicates
  `FrameTimingStats` exactly.
- **Effort:** S. **Risk:** low.

## C-R2-P2 — Shared writer/reader slot-addressing (the dedup C-P4 didn't reach)

- **Locations:** `core/src/ShmRead.cpp` (`ReadMapping::slotHeader/slotData`),
  `core/src/ShmRing.cpp` (`Segment::slotHeader/slotData/header`),
  `core/include/ShmLayout.h`.
- **Current → proposed:** C-P4 unified the *read* mapping/seqlock into
  `ShmRead`, but the **writer** `Segment` still carries its own copy of the
  offset math — `alignUp(sizeof(SegmentHeader), PAGE_ALIGN) + slotStride*slot`
  and `+ dataOffset` — identical to `ReadMapping`'s. → Move the pure offset
  helpers (`slotHeaderOffset(header, slot)`, `slotDataOffset(header)`) into
  `ShmLayout.h` (still dependency-free, `constexpr`), and have both `Segment`
  and `ReadMapping` compute addresses through them.
- **Category:** non-breaking (native refactor; layout bytes unchanged).
- **Rationale:** the addressing formula is now written in **two** places again;
  a future stride/alignment change (the exact V8/V9 class) must land on both or
  silently corrupt one side. C-P4's stated goal — one home for the hard memory
  layout — stops half-way at the writer.
- **Effort:** M. **Risk:** medium — touches the hot writer path; gate =
  `core make build` both runtimes, `08-shm-ring.ts`, reader `otool -L`.

## C-R2-P3 — One SHM transfer-message module (shm-client ↔ preload)

- **Locations:** `app/lib/orchestrator/shm-client.ts` (`ReadRequest`/`ReadDone`
  types) and `app/electron/preload-renderer.ts` (inline `fovea:shm:read` /
  `read-done` message shapes).
- **Current → proposed:** C-P2 moved the pool into `shm-client.ts`, but the
  preload still **hand-redeclares** the request/response message shapes; the two
  ends define the same wire contract twice. → A tiny renderer-safe
  `shm-messages.ts` (or a block in `frame-payload.ts`) exporting the
  `ShmReadRequest`/`ShmReadDone` types + the string `kind` constants, imported
  by both ends.
- **Category:** non-breaking.
- **Rationale:** the transfer is buffer-ownership-critical (MessagePort). A
  field drift between the two hand-written shapes (e.g. `buffer?` optionality,
  the `error` field) is a silent transfer/leak bug — exactly the regression
  class the C-P2 tests guard, but the *shapes* themselves aren't shared.
- **Effort:** S. **Risk:** low (both files C-owned; no preload behavior change,
  but re-run the V11 triplet on the emitted preload since its bytes shift).

## C-R2-P4 — Shared perf-OSD formatter (StreamView + perf dump)

- **Locations:** `app/src/components/StreamView.vue` (`overlay` computed, the
  C-P9 `SHM Reads`/`SHM Pool`/`SHM Read Lat` lines), `app/lib/orchestrator/
  client.ts` (`dumpPerfSnapshot`, `rendererFrameTimingSnapshot`).
- **Current → proposed:** every OSD line is an ad-hoc template string; the new
  `shmReads` lines are formatted inline and their labels/units diverge from the
  `renderer.shmReads` keys the perf-dump JSON writes. → A small
  `formatSampleStats(s)` / `formatCounterRate(c)` (co-located with the shared
  `SampleStats` type from P1) that both the OSD and the dump reference, so
  label wording + units live in one place.
- **Category:** non-breaking.
- **Rationale:** C-P9 exists so the first live SHM issue is diagnosable without
  console tracing; if the OSD label wording drifts from the dumped JSON keys,
  cross-referencing a live overlay against a captured snapshot is exactly what
  gets harder. (Coordinator's explicit round-2 hint.)
- **Effort:** S. **Risk:** low.

## C-R2-P5 — Resolve the split-brain `allWorkloadSnapshots` alias

- **Locations:** `app/orchestrator/metering.ts` (the `@deprecated`
  `allWorkloadSnapshots` alias), `app/orchestrator/sessions/system.ts`
  (line ~67, **A-owned**), `app/test/recorder.test.ts`, `app/test/metering.test.ts`.
- **Current → proposed:** the C-P10 alias was marked `@deprecated` — but A then
  wired the production `perfSnapshot.workloads = allWorkloadSnapshots()` under
  the OLD name. So the "deprecated" symbol is now the live perfSnapshot path. →
  Either migrate the call sites (`system.ts` + tests) to `workloadsSnapshot`
  and delete the alias, or un-deprecate it — but don't leave a deprecated
  symbol load-bearing in production.
- **Category:** non-breaking. **CROSS-ROLE with A** (`system.ts` is A-owned) —
  flag A; I own the metering side.
- **Rationale:** a "temporary alias during C-P10" silently became the shipping
  API surface; that's precisely the drift the deprecation was meant to prevent.
- **Effort:** S. **Risk:** low.

## C-R2-P6 — Retire the dead `publishTelemetry` PlayerHooks alias

- **Locations:** `app/orchestrator/viewer/player.ts` (`PlayerHooks.
  publishTelemetry` field + the `hooks.emitTelemetry ?? hooks.publishTelemetry`
  fallback in `handleMessage`).
- **Current → proposed:** unlike P5's alias, this C-P10 alias is **dead** — the
  only caller (`sessions/viewer.ts`) passes `emitTelemetry`; nothing supplies
  `publishTelemetry`. → Drop the interface field and the `??` fallback.
- **Category:** non-breaking (no caller).
- **Rationale:** dead deprecated surface on the hot per-message path; removing
  it also drops a per-telemetry-message branch.
- **Effort:** S. **Risk:** low.

## C-R2-P7 — Decode cross-checks recorded metadata against the schema

- **Locations:** `app/orchestrator/viewer/decode.ts` (`parseDecodeProps`),
  consuming `docs/schema/pixel-formats.ts` (C-P6 already imports it).
- **Current → proposed:** `parseDecodeProps` trusts the container's
  `significantBits`/`channels`/`dtype` metadata verbatim. C-P6 now gives decode
  a handle on the authoritative `pixelFormatSpec(pixelFormat)`. → Cross-check
  the parsed props against the spec and, on mismatch (an older recorder whose
  metadata drifted from the current schema), account it (a `drop`/warn or a
  telemetry field) rather than silently mis-scaling — display keeps working,
  the drift becomes visible.
- **Category:** non-breaking (additive validation; NO metadata-name changes).
- **Rationale:** the C-P6 conformance suite locks *code* to the schema; this
  extends the same guarantee to *recorded data* whose metadata predates a
  schema change. **CROSS-ROLE / codec seam with B** (B owns the format facts) —
  flag B: the check must read B's `PIXEL_FORMATS`, and B should confirm the
  "metadata may lawfully lag schema" policy before it becomes a drop.
- **Effort:** S. **Risk:** low.

## C-R2-P8 — Align `shmReads` to the `WorkloadSnapshot` shape for the profiler

- **Locations:** `app/lib/orchestrator/shm-client.ts` (stats shape),
  `app/orchestrator/metering.ts` (`WorkloadSnapshot`), future profiler window
  (`app/src/profiler/**`).
- **Current → proposed:** the renderer pool can't import orchestrator
  `metering.ts`, so `shmReads` presents a *different* telemetry shape than
  orchestrator workloads. The profiler (later round) will render both. → Lift
  the neutral snapshot shape (`WorkloadSnapshot`/`CounterRate`, already partly
  in `stats.ts`) into the renderer-safe `@lib/orchestrator` layer so the pool
  can present a workload-shaped block; the profiler then has ONE render path.
- **Category:** non-breaking (additive shape alignment; observe-only).
- **Rationale:** avoids two profiler render paths for "a loop's throughput +
  drops." Builds directly on P1; do P1 first, then decide whether full
  alignment is worth it before the profiler lands.
- **Effort:** M. **Risk:** medium — must NOT drag orchestrator `metering.ts`
  into the renderer bundle; only the pure shape/`stats.ts` crosses.

## C-R2-P9 — Lift viewer position/playing out of the whole-map `state.files` push

- **Locations:** `app/orchestrator/sessions/viewer.ts` (`pushFiles`),
  `app/lib/orchestrator/viewer-contract.ts` (the pinned contract),
  `app/orchestrator/viewer/player.ts` (`pushUpdate` at `POSITION_UPDATE_MS`).
- **Current → proposed:** every throttled position tick rebuilds and re-emits
  the ENTIRE `files` record (all open files, all static channel metadata) as
  one `setState("files", …)`. With N open viewers at ~4 Hz that re-serializes
  static inventory repeatedly. → Move the mutable `positionNs`/`playing` into a
  lighter per-file telemetry channel (mirroring how `playback` docs already
  ride telemetry), leaving `files` for the static inventory that rarely changes.
- **Category:** **breaking** — touches the pinned `viewer-contract.ts` state
  shape → planner/A arbitration (same class as C-P11's contract note). Adjacent
  to A-P7 (contract normalization). Reference, don't land solo.
- **Rationale:** the contract put per-frame-rate position in the same key as
  static inventory; the cost grows with open-file count. Best folded into the
  next contract wave, not done piecemeal.
- **Effort:** M. **Risk:** medium (contract + A's viewer UI consume `files`).

## C-R2-P10 — Trim per-message micro-allocations on the playback hot path

- **Locations:** `app/orchestrator/viewer/player.ts` (`handleMessage`:
  `new TextDecoder()` per telemetry message; `bytes.slice().buffer` copies in
  `decode.ts`).
- **Current → proposed:** a fresh `TextDecoder` is constructed per telemetry
  message. → Hoist a module-scope `TextDecoder` (stateless, reusable). Audit
  the decode copy path for a reusable scratch buffer where the realignment copy
  isn't strictly required.
- **Category:** non-breaking.
- **Rationale:** small but on the per-message loop; free once spotted. Low
  priority — playback is not the throughput-critical path (live capture is).
- **Effort:** S. **Risk:** low.

## C-R2-P11 — Retire the deprecated `ShmSlot.view()` alias

- **Locations:** `core/src/ShmRing.cpp` (`ShmSlot` `view`/`readSnapshot`
  methods), `core/dist/Shm/index.d.ts`.
- **Current → proposed:** C-P5 added `readSnapshot()` and kept `view()` as a
  deprecated alias to steer callers off the misleading name. A repo sweep finds
  no remaining `.view(` shm callers. → If the planner confirms none, drop the
  `view()` alias (and its d.ts entry), leaving only `readSnapshot()`/`write()`/
  `copyTo()`.
- **Category:** **breaking** (removes a public native method + d.ts union
  member) — the "breaking later" half C-P5 flagged. Reference / planner call.
- **Rationale:** the alias only exists to prevent the `view().set(...)` cage
  misuse (V13); once no caller uses it, keeping it re-opens that trap for the
  next coder.
- **Effort:** S. **Risk:** low-to-medium (verify zero callers across app +
  core tests before removal; native rebuild + `otool -L`).
