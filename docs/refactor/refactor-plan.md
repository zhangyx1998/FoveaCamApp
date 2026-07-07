# Refactor plan (post-optimization, 2026-07-07)

Consolidates the HIL findings + architectural directives from the 2026-07-07 rig
session into one sequenced plan. Baseline: optimization waves 1–4 committed
(`87013cd`) + HIL findings log (`hil-findings.md`, `9c99370`). Fleet: **Opus 4.8
is the sole active fleet** (codex out of usage); re-oriented per role.

## North star

**The orchestrator is a thin coordinator, not a per-frame processor.** Every
per-frame pixel/CV path moves off the single JS event loop into C++ threads; JS
keeps only contract, broker, lifecycle, and profiling. HIL proved why:
tracking-single saturates the JS loop (3 `registry:*` camera loops at ~0.97 util,
capture capped ~38 fps, KCF itself only 0.08); manage-cameras freezes on
renderer per-frame buffer allocation. Source memories: `project-orchestrator-
thin-coordinator`, `project-shm-pipe-architecture`, `project-async-kcf-cpp-
thread`, `project-shm-consumer-reuse-buffer`, `project-multi-subwindow-per-app`,
`project-fin-exposure-voltage`.

## Workstreams

### WS1 — Frame path / SHM pipe architecture (C-led; the core)
Target (`project-shm-pipe-architecture`): the orchestrator contract ADVERTISES
typed pipes (pixelFormat, resolution, …); a C++ **producer thread** (capture/CV)
feeds a dedicated C++ **publisher thread** that owns SHM production
(seqlock/memcpy) off the JS loop; the renderer's connect request is brokered to
the publisher; consumers reuse pre-allocated (double-)buffers; the orchestrator
only brokers + probes + tears down; pipes close from both ends.
- **1a — Consumer buffer reuse** (fixes the manage-cameras freeze). Isolated,
  renderer-side, verifiable now. → **WAVE 1 (C)**.
- **1b — Design + scaffold** the producer/publisher thread model, contract pipe
  specs (folds in **C-P12** explicit byteLength/dtype — the pipe spec IS the
  explicit typing), broker mechanism. → planner design section below + **WAVE 2**.
- **1c — Move the SHM ring write** from the JS registry loop into the C++
  publisher thread. Builds on the C-P4 `ShmLayout`/`ShmRead` substrate. Folds in
  **B-P11** (native worker pool). → **WAVE 2/3 (C+B)**.
- **1d — Camera capture + CV into C++ producer threads** (`async-kcf` first,
  `project-async-kcf-cpp-thread`). → **WAVE 3**.
- **1e — Live verification** (hardware): tracking → 60 fps, freeze gone,
  orchestrator `loopLag` < 5 ms. → post-build HIL.

### WS2 — Window management (A-led; independent of WS1)
Target (`project-multi-subwindow-per-app`): apps own 0..N sub-windows; flat
`WINDOWS` policy table + runtime `owner` pointer + `onOwnerClose: cascade|survive`.
- **2a — Ownership foundation**: `owner` pointer on `ManagedWindow` +
  `onOwnerClose` policy field on `WINDOWS` + a keyed toggle helper (the
  `openViewer` dedupe pattern). → **WAVE 1 (A)**.
- **2b — Debug sub-window**: a projection-variant/`debug` entry that carries the
  module's annotation overlay (subscribes to session telemetry) + a drawer
  toggle button; mooting UI-2. Folds in **A-P6** (StreamView/FrameView split).
  → **WAVE 2 (A)**.

### WS3 — UI defects (A-led; small)
- **3a — Title bar full-screen** (UI-1): stable base height, VSCode-style
  traffic-light inset. Fully specified. → **WAVE 1 (A)**.
- **3b — `canvas.centered` overlap** (UI-2): needs live-UI iteration; partly
  mooted by 2b. → **WAVE 2 (A)** (bundle with 2b).

### WS4 — Firmware / protocol v2 (B-led; Stage-F gated for live verify)
Target (`project-fin-exposure-voltage`).
- **4a — FIN exposure-averaged voltage**: sample MEMS at exposure start+finish,
  average, include in FIN + a frame-association key; protocol payload extension.
  Compile-verified (`pio run`), live-verify Stage F. → **WAVE 1 (B)**.
- **4b — Frame↔voltage binding downstream**: thread it through host completion →
  recorder per-frame metadata → viewer/UI. Shares the per-frame-metadata
  mechanism with WS1's pipe metadata. → **WAVE 2 (B + C seam)**.
- Interleaved v2 backlog (still bench-gated): **B-P6** request FSM, **B-P14**
  renames — after the Stage-F bench; **B-P13** capability negotiation — with the
  v2 flash.

### Interleaved previously-planned items
- **A-P1** resource-scoped session lifecycle (was post-GUI-smoke — smoke done):
  foundational for WS2's lifecycle/ownership; sequence into WS2. Breaking.
- **A-P6** StreamView/FrameView split → folds into WS2 2b.
- **B-P11** native worker pool → folds into WS1 1c.
- **C-P12** explicit frame typing → satisfied by WS1 typed pipe specs (1b).
- **B-P6/B-P14/B-P13** → WS4 bench/flash-gated as above.

## Wave plan

**WAVE 1 — dispatched now (concrete, verifiable, dependency-safe, no collisions):**
- **A**: 3a title-bar fix + 2a window-ownership foundation (owner pointer +
  `onOwnerClose` + toggle helper). (UI-2 held for 2b.)
- **B**: 4a firmware FIN exposure-averaged voltage + protocol payload +
  frame-association key (compile-verified).
- **C**: 1a SHM consumer buffer reuse (double-buffer per stream; kill the
  per-frame allocation).

**WAVE 2 — after WAVE 1 lands + the WS1 design review:** the C++ producer/
publisher pipe architecture (1b/1c), debug sub-window (2b + UI-2 + A-P6),
frame↔voltage downstream (4b). Requires the planner design section below to be
ratified first.

**WAVE 3+**: capture/CV producer threads (1d), interleaved v2 backlog, live HIL
verification.

### WAVE 1 — LANDED + planner-verified (2026-07-07; Opus fleet)
- **A-20** (WS3 3a + WS2 2a): TitleBar full-screen fix — `BASE_HEIGHT`, both the
  `height` and `style()` computeds guarded (`|| BASE_HEIGHT` catches the
  full-screen overlay `height:0`; fixed base + `leftInset 0` + full width in
  full screen). **User visual check of both transitions still pending.** Window-
  ownership substrate: `owner`/`key` on descriptor+managed handle, `childrenOf`,
  `onOwnerClose: cascade|survive` (all existing classes `survive`), recursive
  cascade in `onWindowClosed`, keyed `toggle` primitive — plumbing + tests only
  (2b is the first `owner`-setter). +6 tests.
- **B-12** (WS4 4a): FIN now carries `uint32 frame_id` (monotonic, 1-based) +
  exposure-AVERAGED mirror voltage — symmetric ISR strobe-fall latch
  (snapshot before the `strobeHighMask` release-barrier store), per-channel
  round-half-up mean, start-only fallback; threaded host-side (Controller.cpp +
  `.d.ts`). FIN payload spec ratified into `synced-capture.md`. `frame_id`→
  recorder/UI deferred to 4b. Compile-verified only (Stage F for live scope).
- **C-15** (WS1 1a): `shm-client.ts` pool auto-sizes per byte-size to the live
  working-set high-water mark (kills the per-frame multi-MB alloc = the
  manage-cameras freeze); old-size buckets evicted at the next different-size
  checkout (ratified deviation — the literal `outstanding==0` trigger broke the
  pinned single-stream reuse tests). 9 pinned + 2 new tests. Renderer-only.
- **Planner sweep (authoritative):** vue-tsc 0, vitest **226/226**, vite build,
  renderer zero-core / orchestrator zero-Vue, V11 0/0/0, `08-shm-ring` PASS;
  native (B) re-verified: `pio run` SUCCESS (FLASH 89676 B), `core make build`
  both runtimes, `02-serial-protocol` green. Diffs verified against logs.
  Committed as the WAVE 1 checkpoint. **Pending:** user title-bar visual check;
  WAVE 2 (WS1 1b C++ pipe architecture — needs the design decisions ratified;
  C standing by), WS2 2b debug sub-window, WS4 4b frame↔voltage downstream.

### WAVE 2 + WS4-4b vertical — LANDED + planner-verified (2026-07-07; Opus fleet)
- **A-21** (WS2 2b + 3b + A-P6): FIRST `owner`-setter — new `debug` WindowClass
  (the only `onOwnerClose: cascade` class) + `windows/debug.html`/`src/windows/
  debug.ts`/`DebugWindow.vue`/`debug-registry.ts`; `WindowManager.toggleDebug(
  {session,frame}, owner)` (keyed `debug:<session>`, owner=app window) built on
  A-20's `toggle`; bridge chain `toggleDebugWindow`→preload-bridge→main
  `onRenderer`; `planFromManifest` drops cascade classes on restore (owner not
  persisted). A-P6: extracted tracking-single's C-view SVG into reusable
  telemetry-driven `TrackingAnnotations.vue` (main view + debug window share it).
  UI-2/3b: bounded `.centered` in FrameView (first-pass spill guard). **UX call +
  4 UI surfaces flagged for user visual check** (overlay-in-both, debug drawer,
  cascade-close, `.centered`; + A-20 title-bar still pending).
- **C-16** (WS1 1b — THE pipe-architecture scaffold): per-ratified-design. NEW
  `core.Pipe` (`Pipe.h`/`Pipe.cpp`): `Publisher` (one thread/pipe, multi-consumer)
  + `FrameProducer` seam + scaffold `SyntheticProducer` (own thread) — per-frame
  memcpy+seqlock-write off the JS loop; broker `advertise/connect/disconnect/
  close`, `connect→PipeHandle`, refcounted consumers (disconnect→0 pauses, stays
  advertised, reconnect resumes). Segment writer EXTRACTED to `ShmWrite.h`/`.cpp`
  (mirrors the ShmRead split) — live `WriterCore` + `Publisher` share ONE writer,
  live path byte-identical (all live 08-shm-ring cases pass). `ShmLayout.h` v2:
  APPENDED `state` word (existing offsets unchanged, memset default OPEN → zero
  live-path change), `PipeState`, shared `FrameMeta`, `MAX_SLOT_COUNT`, per-segment
  `ringDepth`. Close signal read only on the cold no-new-frame path (final frame
  delivered, then `Closed`). NEW `app/lib/orchestrator/pipe-contract.ts`:
  `PipeSpec` (pixelFormat/dtype read-only from B's schema; explicit `bytesPerFrame`
  = C-P12 typing), `PipeHandle`, `pipes` contract (`connectPipe`/`disconnectPipe`,
  `frames:[]`). **Deferred to 1c** (correct scaffold boundary): the JS session
  handler (`connectPipe`→`core.Pipe.connect`), `core/Pipe` d.ts, renderer display
  consumer — broker proven natively, live wiring is 1c/1d.
- **B-13 + A-22 + B-14** (WS4 4b frame↔voltage vertical, complete end-to-end):
  - **B-13**: NEW `recorder/metadata.ts` — decoder-facing `RecordedFrameExtras`
    (`frame_id`, `volt{x,y}`, `"volt.unit"`, `"volt.source":"fin-averaged"|
    "live-snapshot"`, `angle`, `affine`) + `frameVoltageExtras(frameId,volt)`
    builder; re-exported from `recorder/index.ts`. Writer/worker unchanged
    (`telemetry` doc's `extra` carries it — additive).
  - **A-22** (applied B-13's two handoffs): `controller.ts` `FrameOutcome` carries
    `frameId` (+ doc fixed to exposure-averaged); `recording.ts` builds per-frame
    voltage meta via read-only `frameVoltageExtras` — triggered→`fin-averaged`+
    `frame_id`, free-run→`live-snapshot`; added optional `deps.foveaBinding?(mirror)`
    hook. **Live FIN↔frame pairing is the Stage-F session wiring** (hook present,
    unwired → production stays behavior-preserving `live-snapshot` today).
  - **B-14**: pyfovea reads it back — typed accessors `frame_id`/`volt→XY`/
    `volt_unit`/`volt_source`/`angle` mirroring the literal dotted TS keys;
    additive/optional (older files decode, absent→None). TS contract untouched.
- **Planner sweep (authoritative, over the settled tree):** vue-tsc 0, vitest
  **236/236**, vite build, orchestrator zero-Vue / renderer zero-core, V11
  triplet 0/1/0 (both `.cjs`; preload-bridge inlined into both), `core make build`
  both runtimes (node 23/25/26 + electron 38/41), reader `otool -L` self+libc++/
  libSystem only, `08-shm-ring` unsandboxed PASS (incl. pipe state/close/refcount),
  pyfovea **37/37**. Firmware untouched (no `pio run`). Committed as the WAVE 2
  checkpoint. **Pending:** user visual checks (title-bar + the 4 A-21 surfaces);
  Stage-F live FIN↔frame wiring; WS1 1c (ring-write move + B-P11, C+B) next.

## WS1 design — RATIFIED (planner, 2026-07-07; user "advance aggressively")
1. **Publisher-thread granularity — one publisher thread PER PIPE, multi-
   consumer.** A pipe = one typed producer output. Its publisher owns that pipe's
   `ShmRing` and serves N consumers via the seqlock (one writer, many readers).
   Producer→publisher is 1:1 (producer hands frames to its publisher's latest-
   frame slot). No fan-out thread juggling heterogeneous consumers — each
   publisher's job stays trivial (take latest producer frame, seqlock-write).
2. **Broker mechanism — orchestrator brokers a ONE-TIME handshake; per-frame path
   is pure C++/shm.** On connect: renderer calls JS `connectPipe(pipeId, opts)`;
   orchestrator validates against the contract, tells the C++ publisher to
   ensure/refcount the pipe, returns `PipeHandle = {shmName, spec, ringDepth,
   headerLayout}`. Renderer maps via the existing reader-addon (`reader.readInto(
   handle, dest)` — already reuses `dest`, C-15). JS touches nothing per-frame;
   the publisher owns the segment the JS registry loop used to write.
3. **Contract pipe spec — `PipeSpec = {id, pixelFormat, width, height, dtype,
   channels, stride, bytesPerFrame, ringDepth}`**, dtype/pixelFormat sourced from
   `docs/schema/pixel-formats.ts` (B-owned). Contract advertises `pipes:
   PipeSpec[]`; renderer selects by id. This IS **C-P12** explicit byteLength/
   dtype — the spec is the explicit typing. Lands in a NEW C-owned
   `lib/orchestrator/pipe-contract.ts` (keeps the pinned `viewer-contract.ts`
   untouched; planner arbitrates any later merge).
4. **Symmetric close — explicit CLOSED state in the shm header, refcounted
   consumers.** Seqlock header gains a `state` word (OPEN|CLOSED). Producer-side
   close: publisher sets `state=CLOSED` (release barrier), stops writing;
   consumers observe CLOSED on next read and unmap — an explicit state, NOT a
   frozen last frame. Consumer-side close: `disconnectPipe(handle)` decrements the
   publisher refcount; at zero the publisher may pause production but the pipe
   stays advertised (reconnectable). Full teardown (drop from contract) is an
   orchestrator lifecycle op. Both ends can close; the peer always sees an
   explicit signal.

## Verification
The 2026-07-07 HIL pass surfaced its findings; the refactor rewrites those
surfaces, so `verification-playbook.md` is **paused** — a fresh HIL pass runs
against the new architecture post-WS1. Firmware Stage F/G detail there stays the
reference for WS4's bench/flash.
