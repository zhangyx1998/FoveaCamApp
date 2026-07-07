# Planner triage (2026-07-07)

## SURVEY ROUND 2 TRIAGE (2026-07-07; Opus 4.8 fleet — post wave-2)
Source files: `proposals/{A,B,C}-r2.md`. Ranked re-survey of what waves 1+2
EXPOSED. Classified below; non-breaking green-lit by planner authority (wave-3
backlog), breaking → user.

### GREEN-LIT non-breaking (wave-3 backlog, planner authority)
- **A:** A-R2-P1 (`session-resources.ts` DisposerBag + releaseLeases — 6×
  verbatim teardown; A-P1 building block), P2 (`acquireTriple(s)` + adopt A-P13
  `fail()` on the 5–6× silent triple-guard), P3 (`useController()` composable),
  P4 (`<MarkerTargetInputs>` — renderer twin of A-P4), P5 (`<SessionStatus>`
  banner, fleet-wide A-P13 payoff), P6 (`s.resetTelemetry()` republish contract
  defaults — pin a test), P7 (`bindField()` writable telemetry↔command
  composable), P8 (fold `APPS` metadata into one registry; keep A-P9 explicit
  loader map for vite), P9 (`bindViews` passthrough — closes A-P4 out-of-scope),
  P10 (curated short-name pass on wave-2 survivors, piggyback only).
- **B:** B-R2-P1 (Protocol Method/Property → B-P1 X-macro; host+MCU in one edit;
  byte-identical strings), P2 (generate `pyfovea/schema.py` from `fovea.ts` via
  the B-P1 emitter — byte-compare before commit), P5 (bench harness helpers —
  B-P4 self-duplication), P6 (pyfovea `significant_bits` reads the generated
  table, keep suffix fallback), P7 (trim `cv::Format` enum — LOW value,
  opportunistic only).
- **C:** C-R2-P1 (unify `shmReads` onto `stats.ts` window/rate lineage + shared
  `SampleStats`; PB2 wants reads/sec), P3 (`shm-messages.ts` shared wire types —
  re-run V11 on the emitted preload), P4 (shared perf-OSD formatter — OSD/dump
  label parity), P6 (retire DEAD `publishTelemetry` PlayerHooks alias — no
  caller), P10 (hoist per-message `TextDecoder`; audit decode scratch copy),
  P8 (align `shmReads` to `WorkloadSnapshot` shape — M; do AFTER P1).

### GREEN-LIT cross-role non-breaking (coordinated ownership)
- **C-R2-P5** split-brain `allWorkloadSnapshots`: the C-P10 "@deprecated" alias
  silently became the live `perfSnapshot.workloads` path (A wired it under the
  old name in `system.ts`). Fix: A migrates the `system.ts` call site (+ tests)
  to `workloadsSnapshot`, C deletes the alias. C-owned metering, A-owned call
  site — sequence A-then-C in one wave slot.
- **Codec/dtype seam** — B-R2-P4 (recorder `significantBits`/`channels` resolve
  through `pixelFormatSpec`) + B-R2-P8 (derive the `.d.ts` PixelFormat8/16/12p
  unions from the registry) + C-R2-P7 (decode cross-checks recorded metadata vs
  schema): all consume B's `PIXEL_FORMATS` on C-owned files (`dtype.ts`,
  `.d.ts`, `decode.ts`) — assign to **C** as extensions of C-P6; B confirms the
  format facts and the "metadata may lawfully lag schema" policy. C-R2-P7 stays
  OBSERVE-ONLY (warn/telemetry, NOT a silent drop) until B ratifies the policy.

### DEFERRED (trigger noted)
- **B-R2-P3** packet field-descriptor table (reframed, lower-risk successor to
  the DECLINED B-P5): DEFER to the rig/bench era — `Controller.cpp` is the
  hardware-gated FIN-trace surface; B itself gates on `02-serial-protocol.ts` +
  a rig round. Revisit post-bench with hardware.
- **B-R2-P9** `Controller.cpp` internal renames (`EXPECT_EXACTLY_ONE_ARGUMENT`,
  `VersionPacketStaticProps`, `propertyMap`→`readField`): DEFER — fold into the
  B-P14 post-bench rename pass (B's own recommendation; keep FIN-trace blame
  legible).

### USER DECISIONS (breaking — planner recommendation attached)
1. **C-R2-P9** lift viewer `positionNs`/`playing` out of the whole-map
   `state.files` push (per-frame-rate mutation currently re-serializes static
   inventory at ~4 Hz × N files): touches the PINNED `viewer-contract.ts` state
   shape → breaking. RECOMMEND YES, **bundled into the approved A-P7/A-P12
   contract wave** (same viewer-contract surface + call-site sweep; don't do
   piecemeal).
2. **C-R2-P11** remove the deprecated native `ShmSlot.view()` alias (C-P5's
   "breaking later" half; C's repo sweep finds zero `.view(` shm callers):
   removes a public native method + d.ts union member → breaking. RECOMMEND YES
   — cheap, low-risk, closes the V13 `view().set(...)` cage-misuse trap for the
   next coder; gate = re-confirm zero callers + native rebuild + reader
   `otool -L`.

## WAVE-4 LANDED + PLANNER-VERIFIED (2026-07-07, accepted; Opus 4.8 fleet)
The approved BREAKING contract batch (A-P7 + A-P12 + C-R2-P9 + C-R2-P11), split
fleet: Opus A for A-19; gpt-5.5 C landed C-14 before codex went OUT OF USAGE
mid-wave (→ Opus became the sole active fleet).
- **A (A-19):** A-P7 — 12 wire keys snake→camelCase (`target_id`→`targetId`,
  `wrap_enable`→`wrap`, `depth_window_inv`→`depthWindowInv`,
  `recording_streams`→`recordingStreams`, `record_count`→`recordCount`,
  `active_serial`→`activeSerial`, `capture_busy`→`captureBusy`,
  `set_pid`→`setPid`, `reset_tuning`→`resetTuning`, controller `serial_rate`/
  `settle_time`/`complete_time`) across contracts.ts + all consumers; the
  native controller.ts↔`device.set` boundary correctly KEPT snake (B-owned
  protocol field names). MIGRATION AUDIT (dual-read DoD): all 12 keys checked
  against all 5 persisted surfaces — NONE persisted (only localStorage key is
  `manual-control.set-points`, only URL param is `step`, config docs persist
  role/pixel_format/records/drift) → **ZERO dual-read shims needed**. A-P12 —
  client-only `source` removed from wire `FrameMeta`; `useSession().frame()`
  returns `FrameRef {payload, source}` (source static per session/channel), ~35
  consumers migrated, StreamView reads `FrameRef.source`. Seam close:
  `ViewerWindow.vue` migrated to C-14's `telemetry.position` shape.
- **C (C-14):** C-R2-P9 — `ViewerFile` in `state.files` now STATIC-only; mutable
  `{positionNs,playing}` rides a new `telemetry.position` channel (nulled on
  close) so playback ticks stop re-serializing the whole file map;
  sessions/viewer.ts + player.ts + tests migrated to the planner-ratified
  shape. C-R2-P11 — deprecated native `ShmSlot::view()` DELETED (+ d.ts entry +
  the mirror `view()` in frame-transport.ts's local type); kept
  readSnapshot/write/copyTo; Aravis `Frame.view()` untouched; zero callers
  confirmed.
- **Planner final sweep (authoritative, unsandboxed):** vue-tsc **0** (the
  A-P7 rename-completeness proof — a missed key would type-error), vitest
  **218/218**, vite build clean, renderer zero-core / orchestrator zero-Vue,
  V11 triplet 0/0/0, `core make build` both runtimes (0 errors), `08-shm-ring`
  PASS (run unsandboxed — the codex sandbox blocks `shm_open`), reader
  `otool -L` self+libc++/libSystem only, pyfovea 33/33. `FrameMeta.source`
  removal + `FrameRef` re-verified from code; migration audit spot-checked (no
  renamed key in any persisted-write path). Committed as the wave-4 checkpoint.
- **OPTIMIZATION PROGRAM COMPLETE.** Waves 1–4 done; green-lit +
  user-approved-breaking backlog EXHAUSTED. Remaining optimization items are all
  trigger-gated (B-R2-P3 rig/bench, B-R2-P9 post-bench B-P14, the deferred set).
  NEXT: HIL baseline (Pre-flight + PB2) at this seam, then refactor work.

## WAVE-3 LANDED + PLANNER-VERIFIED (2026-07-07, accepted; gpt-5.5 fleet)
Fleet switched back to gpt-5.5 (Codex) for implementation per user; Opus 4.8
kept warm as the switch-back reserve. Green-lit non-breaking round-2 backlog:
- **A (A-18):** A-R2-P1 (`session-resources.ts`: DisposerBag / releaseLeases /
  bindViews), P6 (`resetTelemetry` from cloned contract defaults + test), P2
  (`acquireTriple` adopting the A-P13 `fail()` on the silent camera-unavailable
  path across drift/distortion/manual/disparity/multi/tracking; extrinsic now
  fails visibly on both paths), P3 (`useController`), P4 (`MarkerTargetInputs`),
  P5 (app-shell `SessionStatus` banner; manage-cameras bespoke banner removed),
  P7 (`bindField`), P8 (`APP_REGISTRY` metadata + co-located explicit Vue
  loaders, A-P9 test green), P10 (extrinsic previewLoop/previewVolts →
  preview/previewVolt). CROSS-ROLE C-R2-P5: `system.ts` perfSnapshot.workloads →
  `workloadsSnapshot`; `recorder.test.ts` migrated off the alias (steering).
- **B (B-11):** B-R2-P1 (Protocol Method/Property enum + strings expand from the
  `FOVEA_PROTOCOL_METHODS`/`_PROPERTIES` X-macro — planner re-diffed EVERY value
  byte-identical NOP=0x00..SYN=0xF0 / NONE=0x00..LOG=0x0F, `#Name` strings
  identical; enum semantic comments restored as a block on steering), B-R2-P2
  (`schema.py` generated from `fovea.ts`; md5-idempotent, byte-compare clean),
  B-R2-P6 (pyfovea `significant_bits` reads the table, suffix fallback kept),
  B-R2-P5 (bench shared `harness.ts`). B-R2-P7 SKIPPED (never entered
  PixelFormat.h). Answered C's codec policy: older-recording metadata may
  lawfully lag schema → warn/telemetry, never drop.
- **C (C-13):** C-R2-P1+P8 (shmReads unified onto the `stats.ts` window/rate
  lineage + workload-shaped block + shared `SampleStats`/`WorkloadSnapshot` in
  renderer-safe `stats.ts`), P3 (shared `shm-messages.ts` wire contract), P4
  (shared OSD/dump formatters), P6 (dead `publishTelemetry` hook removed), P10
  (`TextDecoder` hoisted; decode scratch left un-pooled — Mats outlive decode,
  sound deviation). Codec seam (B-R2-P4/P8 + C-R2-P7): recorder metadata via
  registry helpers, `parseDecodeProps` warns observe-only on schema drift,
  `.d.ts` union partition guard. CROSS-ROLE C-R2-P5 tail: `allWorkloadSnapshots`
  alias DELETED, 0 refs repo-wide.
- **Planner final sweep (authoritative, unsandboxed):** vue-tsc 0, vitest
  **218/218** (−1: obsolete C-P10 alias-pin test removed), vite build clean,
  renderer zero-core / orchestrator zero-Vue, V11 triplet 0/0/0 both preloads,
  `core make build` both runtimes (0 errors), `08-shm-ring.ts` PASS, reader
  `otool -L` self+libc++/libSystem only, pyfovea **33/33**. B-R2-P1 byte-values
  re-diffed, B-R2-P2 generator md5-idempotent, alias grep 0. Committed as the
  wave-3 checkpoint. **Green-lit non-breaking round-2 backlog EXHAUSTED** —
  remaining = DEFERRED B-R2-P3 (rig/bench) + B-R2-P9 (post-bench, fold into
  B-P14), and the WAVE-4 breaking contract batch below.

### WAVE-4 PREP — A-P7/A-P12 contract wave (persisted-key audit, planner)
Wave-4 = the approved breaking contract wave (A-P7 camelCase normalization +
A-P12 explicit frame address) with **C-R2-P9** (lift viewer `positionNs`/
`playing` off the whole-map `state.files` push) and **C-R2-P11** (remove native
`view()` alias) folded in — all reviewed as one contract/API batch (user
2026-07-07). A-P7's gate is a persisted-key audit; done 2026-07-07 — the
surfaces whose ON-DISK/persisted keys could break under a wire-key rename, each
needing a migration or back-compat read shim in the A-P7 instruction:
- `app/orchestrator/store.ts` — atomic JSON config written to `<userData>/
  store/*` (the persisted config store; keys are the live risk).
- `app/orchestrator/camera.ts` — persisted per-camera config (pixel format,
  frame rate, exposure, …) restored on enumerate.
- `app/orchestrator/store-hub.ts` — the single write/broadcast path for every
  persisted config doc (`store:<path>`), incl. renderer `Store` writes.
- `app/electron/window-manifest.ts` — persisted window manifest ({class,
  landing URL, state}) rides the same store file layout.
- Renderer localStorage: `app/lib/local.ts`, `app/lib/util/index.ts`
  (JSON-serialized under caller-supplied keys).
DoD for the A-P7 instruction: any renamed key that is READ BACK from one of the
above must either migrate old docs on load or accept both spellings for one
release. Not started (wave-3 non-breaking backlog runs first).

## WAVE-2 LANDED + PLANNER-VERIFIED (2026-07-07, accepted; Opus 4.8 fleet)
- **A (A-16):** A-P4 (`marker-calibration.ts` Vue-free primitives, adopted
  extrinsic/drift/distortion), A-P8 (`WINDOWS` taxonomy table feeding
  windows/manager/manifest/main + coverage test), A-P10 (types-only bridge
  channel registry — `import type` erases, V11 intact), A-P11
  (`CAMERA_CONTROLS` schema, `safe()` preserved, compile-time drift guard;
  only helper aliases `Range`/`AutoMode` relocated — no field renames),
  A-P13 (per-session `status`/`SessionStatus` channel + `fail()`/`clearError`,
  manage-cameras reference consumer; fixed a latent bug — `error()`'s
  doc-promised renderer forwarding never existed).
- **B (B-9):** B-P1 (single `PIXEL_FORMATS` registry at
  `docs/schema/pixel-formats.ts`; trivial hand-run emitter writes checked-in
  `PixelFormat.gen.h` X-macro + `pyfovea/pixel_formats.py`, NOT build-wired;
  enum names/order + 12p comments preserved; orphan `PixelFormat.ts` deleted;
  stale `CAPACITY=8` comment killed), B-P4 (bench drives the PRODUCTION
  `McapWriterWorker`, compression a bench-only lazy-required seam — 0
  compressor hits in `orchestrator.js`; single-writer bottleneck reproduces
  unchanged), B-P10 (additive `iter_frames_streaming()`, bounded memory on
  truncated files; default `iter_frames()` untouched).
- **C (C-11):** C-P2 (SHM transfer pool → `shm-client.ts`, behavior-identical,
  ownership tests), C-P4 (shared libc-only `ShmLayout.h`/`ShmRead.{h,cpp}` in
  both core + reader; fences/retry-cap byte-preserved; readers otool-clean),
  C-P7 (streaming truncated playback, bounded-memory test), C-P9 (additive
  `renderer.shmReads` telemetry + OSD, observe-only), C-P11 (session-layer
  viewer-open dedupe; contract wording planner-ratified into
  `viewer-contract.ts`), C-P6 (`dtype.ts` + `viewer/decode.ts` consume B-P1's
  table + 4-test conformance suite; dtype.ts reverts A→ after wave).
- **Planner sweep (authoritative, unsandboxed):** vitest **214/214**,
  vue-tsc 0, `core make build` both runtimes (incl. deterministic re-gen of
  `PixelFormat.gen.h`), readers `otool -L` self+libc++/libSystem only,
  `08-shm-ring.ts` PASS, pyfovea **33/33** (incl. B-P10 streaming), vite
  build + V11 triplet 0/0/0, renderer zero-core / orchestrator zero-Vue, C++
  `packed12`+`cobs` fresh-rebuilt PASS (B-P1 no native drift). Non-breaking
  verified against diffs: A-P13 additive (no protocol deletions), A-P11 no
  field renames, B-P1 generator deterministic. Committed as the wave-2
  checkpoint. **Green-lit non-breaking backlog now EXHAUSTED** — remaining
  items are the user-approved breaking waves (A-P7+A-P12, A-P1) and the
  trigger-deferred set below.

## WAVE-1 LANDED + PLANNER-VERIFIED (2026-07-07, accepted)
- **A (A-15):** A-P2 (tracking-single display vision → named frame
  workers `tracking:center`/`tracking:fovea:{L,R}` with idle cancel),
  A-P3 (Vue-free `fovea-pipeline` primitives, adopted tracking/manual/
  disparity), A-P5 (`useFrames`/`useDynamicFrame`, 5 call sites), A-P9
  (app-registry consistency test, explicit loader map kept), A-P14
  (approved renames only; vetoes untouched).
- **B (B-8):** B-P2 (12p vectors in `docs/schema/codec/` + `Codec/
  Packed12.h`, consumed C++/TS/pyfovea), B-P3 (schema-as-code
  `docs/schema/fovea.ts` + mirrored `pyfovea.schema`, writer/converter/
  bench on real names), B-P7 (chunked host serial RX, byte trace behind
  VERBOSE), **B-P8+B-P9 (firmware PendingAction helper + fixed Ring
  queue — post-edit `pio run` SUCCESS, planner-verified: FLASH 89 420 B,
  the compile gate B set as its DoD).**
- **C (C-10):** C-P3 (shared `@lib/orchestrator/stats` window/rate
  bookkeeping), C-P5 (`readSnapshot()` + deprecated `view()` alias),
  C-P8 (process-local topic-key collision registry that THROWS +
  costarring/liquid test), C-P10 (approved renames + aliases; vetoes
  kept), C-P1 (`frame-payload` normalizer adopted at all 5 meta-merge
  sites + precedence test).
- **Planner sweep (authoritative, unsandboxed):** vitest **174/174**
  (the 173/174 both A and C reported was mid-flight concurrent-codec
  timing — `codec-fixtures.test.ts` passes clean now), vue-tsc 0,
  `08-shm-ring.ts` shm smoke PASS (C's sandbox couldn't run it), pyfovea
  28/28, `core make build` both runtimes, firmware `pio run` SUCCESS,
  vite build + V11 triplet (0/0/0 on both preloads). Committed as the
  wave-1 checkpoint.


## GREEN-LIT (non-breaking; planner authority) — dispatched in waves
- A: P2, P3, P4, P5, P8, P9, P10, P11, P13, P14 (P14 minus two vetoed
  renames: keep `activeSubscribers`, keep `telemetrySnapshot` — load-
  bearing precision in runtime core).
- B: P1 (generator stays trivial; artifacts checked in), P2, P3, P4,
  P7 (byte-level trace preserved behind verbosity), P10 (additive
  `iter_frames_streaming` only). P8/P9 conditional: only with a
  passing local firmware compile; else deferred to bench era.
- C: P1, P2 (buffer-ownership tests pinned: success/null/timeout/stale),
  P3, P4 (shared TU must stay libc-only), P5 (alias phase only),
  P7, P8 (choose the process-local collision registry that THROWS),
  P9, P10 (minus vetoes: keep `latestBefore` — the proposed name is
  longer; drop `workloadSnapshot→snapshotWorkload` churn), P11
  (ratified as documented dedupe semantics — matches one-window-per-
  file product rule; planner arbitrates the contract note).
- CROSS-ROLE CODEC ITEM (merged B-P1+B-P2+B-P3+C-P6): one conformance
  fixture set + shared format tables; B owns format facts and the
  fixture, C owns the TS decode conformance side. Tests-first, then
  registry.

## PLANNER-DEFERRED (with reasons; revisit at the named trigger)
- A-P6 (StreamView/FrameView split) — after the user's Stage 5 GUI
  smoke (UI regressions need a live baseline first).
- B-P6 (request FSM) — MUST NOT precede the P4.1 bench: the diagnosis
  needs the code that produced the symptom.
- B-P14 (protocol renames) — post-bench (trace-history legibility).
- B-P11 (native worker pool) — needs multi-fovea live load numbers.
- B-P5 (protocol codegen) — DECLINED for now: L-effort/high-risk
  codegen on a hardware-gated surface right before bench; B-P2-style
  spot tests guard the drift more cheaply until v2 stabilizes.
- C-P12 (explicit byteLength/dtype in FramePayload) — recorded as a
  HARD GATE on any future raw/16-bit/12p shm transport dispatch; no
  code now.

## USER DECISIONS (breaking-but-better; planner recommendation attached)
1. A-P1 resource-scoped session lifecycle — RECOMMEND YES, scheduled
   AFTER the Stage 5 GUI smoke (it rewires every hardware session's
   activation; the bug class it kills produced V1/V5/V10/RT1/PB3).
2. A-P7 contract camelCase normalization — RECOMMEND YES, soon
   (call-site count only grows); needs a persisted-key audit first.
3. A-P12 explicit frame address (kill the meta.source mutation) —
   RECOMMEND YES, bundled with A-P7 (same call-site sweep).
4. B-P12 recorder full-res sharding — THIS IS the pending full-res
   tier question, now with an implementation sketch. Decide the tier;
   sharding follows or stays shelved.
5. B-P13 capability negotiation (vs major-version math) — RECOMMEND
   YES bundled with the v2 flash at Stage F (needs firmware
   coordination anyway).

## USER DECISIONS TAKEN (2026-07-07 — "all recommendations accepted")
1. A-P1 lifecycle unification: APPROVED — scheduled AFTER the Stage 5
   GUI smoke (wall item gates it).
2. A-P7 camelCase normalization: APPROVED — next optimization wave
   after wave 2, preceded by a persisted-key audit.
3. A-P12 explicit frame address: APPROVED — bundled with A-P7.
4. B-P12 sharding: per recommendation, SHELVED — current 1.5 MiB tier
   suffices; sharding revives if/when full-res raw recording becomes a
   requirement (the topology seam keeps it additive).
5. B-P13 capability negotiation: APPROVED — bundled with the v2 flash
   at Stage F.
