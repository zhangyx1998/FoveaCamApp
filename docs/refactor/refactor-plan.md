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

### WAVE 3 — LANDED/in-progress (2026-07-07; Opus fleet; posture: converge at milestone)
- **C-18** (ACCEPTED, planner-verified): per-stream `maxIntervalMs` = trailing-10 s
  max inter-arrival, as **10×1 s bins in a ring** (rotate by wall-clock; live
  in-progress stall via `max(bins, now−lastEventTs)`), observe-only O(1)/event, in
  `metering.ts` + profiler (amber >2× nominal). Transport-agnostic schema
  (`WorkloadStreamStat`/`INTERVAL_WINDOW`) for the future native thread meter to
  reuse. Diagnostic to rule producer-lag in/out. Planner re-ran: metering 19/19,
  and the bin math is correct. Handoff to A: add `maxIntervalMs` to the workload
  stream-stat type in `stats.ts`/`contracts.ts` (runtime already flows it).
- **C-17** (ACCEPTED, planner-verified): full SYNTHETIC pipe consumer stack —
  `core/Pipe` d.ts+glue, C-owned `pipe-session.ts` broker (`asBroker(Pipe)`),
  renderer/preload consumer (`shm-client.readPipe` reusing the C-15 pool,
  `pipe-consumer.ts`), `core/test/09-pipe.ts`. **Zero live-path change proven**
  (`registry.ts` untouched — confirmed by absence). Planner re-ran: 09-pipe PASS,
  08-shm-ring PASS (live regression-free). Deferred to real-1c (C-19): live
  registry cut-over + orchestrator-index wiring + StreamView binding.
- **B-15** (4 non-breaking batches, accept pending the milestone sweep): pyfovea
  accessor edge cases + pixel-formats tests (pytest 53/53); TS↔C++↔py codegen
  conformance test; host-side `FrameResult` round-trip + 37-byte wire-layout test;
  compile-time host+MCU wire-layout `static_assert`s (core both runtimes + `pio`
  SUCCESS FLASH 89676). Frame↔voltage substrate now covered write+read+schema+wire.
  Loop PAUSED (no-churn rule) — remaining B candidates are bench-gated/low-value.
- **A-P1** (IN PROGRESS, A-23 loop): resource-scoped session lifecycle (breaking,
  own-surface, green-lit) + window-substrate test coverage. Not yet reported
  complete. Tree UNCOMMITTED (posture: commit at milestone convergence, not
  per-wave).

### WAVE 4 — LANDED + planner-verified (2026-07-07; Opus fleet) — the free-running-thread milestone (BUILD side)
Both milestone threads are built off the JS loop + instrumented; live cut-over + rig
pass remain. Session-limit interruption (reset 7:40pm ET) hit mid-wave; all resumed.
- **C (pipe/producer/instrumentation stack):** C-17 synthetic pipe consumer stack;
  C-18 `maxIntervalMs` diagnostic (10×1s-bin ring, live in-progress stall) +
  transport-agnostic metric schema; C-19 **SHM producer C++ thread** (publisher
  collapsed onto producer per B's single-consumer-pop finding — 1 copy, no extra
  thread) + standalone `ThreadMeter` (probed out-of-loop into `perfSnapshot.
  workloads`); C-20 **dynamic pipe lifecycle** (keyed discovery Record, layout-v3
  per-frame active w/h in a max-fovea-sized ring = resize w/o recreation, epoch
  reuse-safe ids, churn-consistent `probeAll`). `viewer-contract.ts` untouched.
- **B (Aravis capture + tracker thread):** B-15 test-coverage batches; B-16
  `Arv::CaptureSink` (subscriber on the existing per-camera stream thread →
  convert→`offer()` to C's ring; frame-release hazard structural); B-17p1
  `attachCameraPipe` NAPI + fake-camera for camera-free tests; **B-17 1d — KCF
  tracker C++ thread** (`KcfTrackerStream : TransformStream`, `Sub::Latest` on the
  center camera, full-frame KCF off-loop, async-generator results, reuses C's
  `ThreadMeter` + a new latest-wins drop counter; test proves 5 off-loop results +
  drops 0→12 under induced stall). v1 crop-in-JS→C++ port deferred.
- **A (A-23/A-P1, IN PROGRESS):** `resource-session.ts` (`defineResourceSession`/
  `ResourceScope`, unit-tested async-drain/staleness) + **5/6 triple sessions
  migrated** (drift/distortion/multi-fovea/extrinsic/tracking-single;
  manual-control remaining) + window/frame↔voltage test coverage + the C-18
  `maxIntervalMs` type handoff (landed optional to not break C's fixtures).
- **Parallel tooling (during the quota downtime; `typescript.md`):** Electron
  `*.ts` type-checking fixed via `moduleResolution:"bundler"` + tsconfig
  restructure + `electron-env.d.ts` cleanup. Folded into this commit; vue-tsc
  green against it.
- **Planner sweep (authoritative):** vue-tsc 0, vitest **277/277**, vite build,
  orch zero-Vue / renderer zero-core, V11 0/1/0, `core make build` both runtimes,
  native `08–12` all PASS unsandboxed, reader `otool -L` clean, pyfovea **53/53**.
  **Pending:** the A-side live cut-over (real-1c + 1d: retire registry JS SHM write
  + `AsyncKcfTracker`; advertise `camera:<serial>`; StreamView→pipe; `probeAll`
  splice) + A-P1 manual-control; then the USER's rig pass.

## NEXT MILESTONE — per-frame work on its own free-running threads, instrumented (user-set 2026-07-07)
The next solid milestone the **user verifies at the rig**: the per-frame pixel/CV
work is moved OFF the orchestrator JS event loop into dedicated **free-running C++
threads**, AND each such thread exposes an **instrumentation API used for
profiling**. Two named threads for this milestone:
1. **SHM producer thread** (WS1 real-1c) — per-frame SHM production (memcpy +
   seqlock write) runs in the C++ publisher thread; the JS loop no longer touches
   the camera→SHM preview path.
2. **KCF tracker thread** (WS1 1d / `project-async-kcf-cpp-thread`) — the
   center-camera KCF runs in its own C++ thread consuming the latest frame,
   results back via async generator; off the JS loop.

**Instrumentation API (load-bearing, not optional).** Because these threads run
free of the JS loop, the orchestrator can no longer time them from JS. Each
free-running thread must record its OWN metrics — the **C-18 max-interval (10 s /
1 s-bin) + rate + utilization + drops** block — in a lock-free structure the
orchestrator **probes out-of-loop** (reads the metric block, never per-frame) and
forwards to the profiler. The metric block SCHEMA must be shared between the JS
`Workload` meter (C-18) and the native thread meter, so the snapshot + profiler
shape is stable across the JS→C++ move. This is the `project-shm-pipe-
architecture` "orchestrator only probes profiling data" principle made concrete.
- **C path:** C-18 (JS max-interval diagnostic — profiles the CURRENT JS producer,
  and DEFINES the shared metric-block schema) → C-17 (1c-prep synthetic stack) →
  **real-1c** (SHM producer C++ thread + its native meter) → **1d** (KCF C++
  thread + its native meter).
- **Cross-role seam (flag for real-1c dispatch):** the live SHM write currently
  lives in `registry.ts` (A-owned); real-1c removes it there and wires the camera
  frame to the C++ publisher — A↔C coordinated, planner-arbitrated.
- **Verification is the user's rig pass** (freeze gone / tracking ~60 fps /
  orchestrator `loopLag`<5 ms / each thread's `maxInterval` flat in the profiler).

## REFACTOR POSTURE (user 2026-07-07): break freely, CONVERGE at the milestone
Intermediate breakage is FINE — the tree may be red between waves; a wave need not
leave every gate green before the next dependent step is dispatched. The only hard
constraint is that the pieces **converge on the milestone** (green + rig-verified
there). So:
- **real-1c is GREEN-LIT to break the live SHM preview path** — no pre-hardware
  hold, no waiting on the C-18 verdict. C proceeds C-18 → C-17 → real-1c → 1d and
  we converge; C-18 stays on the path only because it DEFINES the shared metric
  schema (a milestone deliverable) and cheaply gives the producer-lag verdict.
- **Coders may break things WITHIN their own surface** (restructure, break internal
  APIs, leave their own area red across batches) when it's higher-value and
  converges by the milestone.
- **The planner still SEQUENCES cross-role / contract / persisted-surface breaks**
  — that is convergence management, not timidity: two roles breaking a shared
  boundary without sequencing is the one thing that fails to converge. Those get a
  planner-arbitrated handoff; everything else, just do it.
- The planner still verifies at convergence/commit points and the user commits at
  checkpoints; we simply stop gating forward motion on per-wave greenness.

## WS1 pipe protocol — DYNAMIC LIFECYCLE constraint (user 2026-07-07)
The pipe set is NOT mostly-static. In the **multi-fovea tracking** app, fovea
streams are **created and destroyed on the fly** (user interaction + scene
change), and each fovea's crop **resizes continuously** as it tracks. The
protocol must be designed for churn from the start, not retrofitted:
- **Consumer discovery / reactive pipe-list:** the renderer must learn of pipes
  appearing/disappearing at runtime — a subscribable advertise/un-advertise
  stream, NOT a one-time contract read. (Main gap in the C-16/17/19 protocol,
  which advertises but has no live discovery channel.)
- **Cheap, leak-free churn:** create/destroy many pipes rapidly with no leaked
  shm segments/threads. The C-19 collapse (no thread-per-pipe) already helps;
  verify `shm_unlink` on drop + bounded resource use.
- **Frequent resize:** a tracking fovea resizes every few frames — "drop +
  re-advertise" (C-19's size-change policy) recreates the segment each time =
  too churny. Need a better policy: ring sized to a MAX fovea footprint with a
  varying active w/h inside it, or in-place resize up to a cap.
- **Reuse-safe identity:** unique ids across churn (`fovea:<session>:<id>` with a
  generation/epoch) so a consumer on a stale id sees CLOSED, never silently
  binds to a reused id.
Source: [[project_multi_fovea_dynamic_pipes]]. The immediate manage-cameras
milestone uses static `camera:<serial>` pipes, but the protocol is designed for
the dynamic case NOW (C-20) so the cut-over's advertise/notify wiring is right.

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

## real-1e + real-1f — LANDED + planner-verified (2026-07-08; the loop-elimination milestone)

Root cause (user snapshots): `registry:<serial>` JS view-tap loop at 0.94–0.997
util (`frame.view("BGRA8")` per frame, per camera) capped the vision apps at
~20fps and starved the serial (~40Hz, loopLag 12–19ms).

- **real-1e (2822fc3, 74f6dd9):** modular per-stream converter threads —
  `convertFrame` single source of truth (killed the 12p-stripe duplication),
  `ConverterStream` per (camera × target) selected by `PipeSpec.pixelFormat`,
  consumer-gate (pipe refcount → subscribe/park; idle when no pipe open),
  `converterProbeAll` in the profiler.
- **Context-safety + teardown hardening (6e1fe32, da349da, 95519b9, 8f0d3e9):**
  reader + ShmSlot/Writer per-env instance data (worker_thread-safe core.node);
  orderly-teardown fan-out proof; Dispatcher cleanup() hang + pending-future
  registry-lock deadlock fixed. Native sweep 08–17 all clean exit 0.
- **real-1f (0b981c1, 6511f13, 51aab8d, 67ae273, f555169):** ALL vision off the
  JS event loop. Vision worker_thread architecture (main brokers connectPipe →
  gate; worker SHM-reads read-only, runs kernels: disparity / display /
  distortion / checker), serials exposed to the renderer, raw previews →
  `usePipeFrame`, and the registry view-tap loop + `registry:<serial>` meter +
  frame-worker + bindViews DELETED. Registry = pure lease broker + pipe
  advertise/attach. `grep 'registry:' orchestrator.js` = 0.
- **Profiler + serial (4492a1e, a61c7fc, 6bb0f70, 4b2ba4e, 69ff824):** saturation
  flag + util-sorted workloads; pipe frames carry convertMs/gen/retries (full
  StreamView metrics everywhere); snapshot path logged + open-folder button;
  `controller:<port>` packet-rate meter; hot actuation → fire-and-forget
  CMD_STREAM (`predictVolts` local telemetry, v1 fallback) unlocking kHz past
  the awaited-RTT cap; window entry HTML generated from the registry.

**Known follow-up:** multi-fovea's multi-target KCF (`runtime.onCenterFrame`)
still runs on the main loop — the async-kcf → dedicated-C++-thread refactor.
**RIG-GATED:** worker vision parity (6 migrated apps), fps recovery, serial rate
(controller:<port> meter), predictVolts echo accuracy, no Streams::snapshot
corruption, converter preview parity (12-bit), 16 generated windows load.
