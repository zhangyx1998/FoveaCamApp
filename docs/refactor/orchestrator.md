# Refactor: Decouple Orchestrator from Renderer

> **Status:** **STAGE 2 in progress** (user direction 2026-07-04): renderer
> goes fully `core`-free (S1, incl. disparity — gate resolved by fiat),
> store-hub becomes the *sole* store owner (S2), recorder moves to a worker
> thread (S3), a dedicated profiler window lands (S4, GUI-verifiable
> without cameras), and startup/debug spans make spin-up time measurable
> (S5). Hardware verification still deferred (mechanical work); commit
> checkpoint still recommended before Stage 2 lands.
> **Branch:** `refactor/decouple-orchestrator`
> **Owner:** Yuxuan (plan) / coder thread (implementation). Entries marked
> **(coder)** are reports from the implementing agent; ✓ marks planner
> verification against code.
> **Last updated:** 2026-07-04 (full step-by-step log in git history)

---

## 1. Problem

The renderer process used to *be* the orchestrator: with `nodeIntegration`
on, it imported the `core` NAPI addon directly and owned camera acquisition,
vision, control loops, hardware I/O, and config — all on the same JS event
loop as the Vue/Chromium render pipeline. Consequences: control cadence bound
to vsync (`requestAnimationFrame` pacing), native async completions competing
with layout/paint/GC, and jank coupling both directions. Secondary: per-
renderer camera ownership meant streams could not be shared across windows.

## 2. Objectives

- **Primary:** move the orchestrator (acquisition, vision, control, hardware
  I/O, config) onto a process with its own event loop; renderer becomes a
  thin I/O surface.
- **Secondary:** multiple renderer windows subscribing to the same stream
  (control window + stereo-projector pair) without duplicating acquisition.
- **Transport observability:** reuse `StreamView`'s inspector/OSD as a
  built-in profiler for the frame IPC path (landed — §5); it also produces
  the profiling evidence the zero-copy decision is gated on.
- **Non-goals (for now):** rewriting `core` native internals, changing
  calibration math or control algorithms, multi-machine operation.

## 3. Architecture (as built)

```
┌─────────── Orchestrator (Electron utilityProcess, own libuv loop) ──────────┐
│  owns `core` NAPI: Aravis / Vision / Tracker / Controller                   │
│  registry.ts: one shared Camera + one preview loop per serial (leases)      │
│  sessions: system, controller (+ per-module session.ts, co-located)         │
│  frame-driven control loops, serial I/O, store-hub, calibration loader,     │
│  capture/recording (raw frames never cross the boundary)                    │
│  exposes: typed RPC + state echo + telemetry + backpressured frames         │
└───────────────▲───────────────────────────┬────────────────────────────────┘
                │ commands / state writes    │ frames + telemetry (lossy,
                │ (MessagePort RPC)          │  latest-wins, structured clone)
   ┌────────────┴────────┐         ┌─────────┴────────────┐
   │ Renderer A (control) │  ...   │ Renderer B (projector)│   ← main process
   │ thin Vue views       │         │ (future)             │     brokers ports
   └──────────────────────┘         └──────────────────────┘
```

**File map**
- `app/lib/orchestrator/` — shared by both processes:
  - `protocol.ts` — `Channel` (req/res, events, frames + per-topic in-flight
    backpressure gate, process-wide `error` event), `defineContract`/`cmd`,
    `FramePayload {data, shape, channels, meta?: FrameMeta}`. `FrameMeta` =
    `seq` (per-topic counter, assigned on *every* `sendFrame` so received-seq
    gaps measure exactly what the gate dropped), `tCapture`/`convertMs`
    (producer-stamped), `tPublish` (stamped at the actual wire-post instant).
    All host-clock `Date.now()` — device-clock correlation is the
    synced-capture thread's job, not this header's.
  - `contracts.ts` — cross-cutting contracts (`system`, `controller`);
    feature contracts live in `modules/<m>/contract.ts`.
  - `client.ts` — `connect()`, `useSession(contract, name)` → `{ state,
    telemetry, frame, call }` (`state`/`telemetry` are Vue `reactive()`
    objects; `frame(name)` rAF-coalesced refs, stamps `tReceive`/`tDisplay`);
    `payloadToMat`; `releaseOrchestratorCameras()`; diagnostics auto-logged;
    channel closed + pending RPCs rejected on `orchestrator:down`.
- `app/orchestrator/` — utilityProcess infra:
  - `index.ts` — registration list; eager `core` import; synchronous
    `shutdown()` on `SIGTERM`/`exit`; main `kill()`s it on `before-quit`.
  - `runtime.ts` — `ServerSession` (authoritative state, snapshots seeded on
    subscribe, interest counting → `onActivate`/`onIdle`, `dispose()`),
    `Hub` (multiplexes sessions + attaches the store hub per channel),
    `defineSession(name, contract, build)` (exhaustive `commands`, typed
    `watch`).
  - `registry.ts` — camera/stream registry: `acquire(serial)` → refcounted
    `CameraLease` (`camera`, `onFrame` payload sink, `onView` in-process Mat
    tap — reused buffer, valid only during the call, `reconfigure`,
    `release`); one `Camera` + one BGRA preview loop per serial, one
    conversion fanned to all sinks; `releaseAll()` awaits in-flight closes.
    RT1 additions: `retryUntil(attempt, {timeoutMs, intervalMs})` (bounded
    backoff for camera-owning activations), `acquireMany(serials)` (one bulk
    discovery pass), `matchTriple()` (role-match L/C/R without opening
    non-matches; wrap in `retryUntil` at call sites).
  - `store.ts` (fs primitives: atomic tmp+rename writes, per-path
    serialization) + `store-hub.ts` — **single config owner** (roadmap item
    4, landed): per-path in-memory doc cache + change notification; renderer
    `Store` (`app/lib/store.ts`) is now a thin RPC client over
    `store:read/write/clear/list` + per-path broadcast, echo-skipping the
    originating channel. Same `Store.open/clear/list` public API — zero
    call-site changes. Values cross by structured clone (no JSON codec
    renderer-side).
  - `controller.ts` — serial device + module-level `activeController()`
    shared with control-loop sessions.
  - `calibration.ts` — `loadCalibratedTriple()` / `loadConversions(L,C,R)` /
    `leaseCalibratedTriple()` (registry-leased variant).
  - `camera.ts`, `diagnostics.ts` — helpers; error forwarding to renderers.
  - `actuation.ts`, `stream-writer.ts`, `stream-decoder.py` — shared
    actuation loop; raw `.stream`/`.meta`/manifest writer (relocated from
    `src/record/stream.ts`, on-disk format unchanged — external tooling
    depends on it).
  - `sessions/` — only `system` and `controller` (cross-cutting singletons).
- `modules/<m>/{contract.ts, session.ts, index.vue}` — a feature is one
  directory; sessions reach infra via `@orchestrator/*`. manual-control adds
  `capture.ts`/`recording.ts` (session-side).
- Pure libs loadable in both processes: `lib/camera-config.ts`,
  `lib/controller-codec.ts`, `lib/coordinate-conversions.ts`,
  `lib/store-codec.ts` (now on-disk only), `lib/util/rolling.ts` (Vue-free
  meters for orchestrator code — `lib/util/perf.ts` is deliberately
  Vue-tainted: its `ref` powers the inspector OSD; don't "fix" it).

**Hard rules (learned at runtime; keep honoring):**
- **Vue-free orchestrator.** `vue` is a devDependency — anything a
  `session.ts` reaches must not import it (gate: zero Vue symbols in the
  orchestrator bundle). Renderer-side meters live in `perf.ts`;
  orchestrator-side in `rolling.ts`.
- **Camera exclusivity is per OS process.** `arv_camera_new` fails while the
  *other* process holds the device; same-process re-opens are deduped by
  `core`'s per-process refcount registry (`core/lib/Aravis/Camera.cpp`).
- **`MessagePortMain` cannot transfer `ArrayBuffer`s** — frames cross by
  structured clone; never pass a transfer list.
- **Extract data from a `Frame` before `release()`** — never touch it after.
- **Externalization:** Node builds' `external` must match deps *and
  subpaths* (`isExternal(id)` in `vite.config.ts`).
- **Numeric inputs:** use `RangeSlider` (emits numbers); raw range inputs
  emit strings and native setters throw.

## 4. Design decisions (locked)

| Decision | Outcome |
|---|---|
| Host | Electron `utilityProcess`; ports brokered by main via `MessageChannelMain`. |
| Transport v1 | One `MessagePort` per renderer; RPC + events + frames multiplexed; frames structured-clone, lossy latest-wins via per-topic in-flight gate. |
| Zero-copy path | SAB-over-MessagePort is **not implementable** (SAB clones only within one OS process). Real design: **native shared memory in `core`** (`shm_open`/`mmap` + seqlock header; sidesteps COOP/COEP entirely). Deferred — roadmap gate. |
| Contract/RPC | Hand-rolled typed layer: `defineContract` + `defineSession` + mirrored `reactive()` client. |
| Control cadence | Frame-driven (`registry.onView`) or real timers; no rAF server-side. |
| State ownership | Orchestrator authoritative; renderer writes echoed to *other* windows only; snapshots seeded on subscribe. |
| Config store | ✅ **Single owner landed** (store-hub, roadmap item 4): orchestrator caches + broadcasts; renderer `Store` is an RPC client. Scoped down from `async-reactive.md` (no revisions/merge/meta — last-write-wins + echo-skip, matching the rest of the system; `Store.resolve`/`save` dropped, unused). |
| Lifecycle | Session interest counts drive resources; registry leases refcount cameras; `system.releaseCameras` disposes camera-owning sessions then `releaseAll()` backstop. R4 (leases only via session lifecycle) intentionally unfinished. |
| Capture/record placement | Wholesale orchestrator-side (R5a landed): raw/high-bit-depth frames never cross the boundary; renderer gets 8-bit BGRA previews + trigger/progress UI. |

## 5. Migration state

| Module | State |
|---|---|
| single-capture | ✅ thin client over `liveview` session. |
| manage-cameras | ✅ per-serial dynamic frame channels, 1 Hz property telemetry, commands persist via store-hub. |
| controller (title bar) | ✅ orchestrator owns serial; `Controller.vue` thin client; `getController()` facade preserved. |
| tracking-single | ✅ KCF frame-driven off `onView`; ~1 ms actuation loop; full display vision (undistort-before-track, wrap, fovea, diff/depth). Never had capture/record. |
| manual-control | ✅ (coder ✓ verified in code review) display/control + **capture/recording** in one pass (splitting wasn't viable — both read raw frames off the same leases; user approved). Capture: raw L/R stacked 16-bit server-side, held in `pending` until save/discard; BGRA previews stream as `capture:<name>[#i]` frames. Recording: three raw `camera.stream` consumers (safe concurrently — `core`'s `Sub::Queue` gives each iterator its own bounded backlog) → `stream-writer`. Renderer chrome (`current_capture`/`current_recording`, camera icon, RecordButton) unchanged; `Capture`/`Recording` are thin RPC facades scoped to the module. Known gaps: capture not cancellable mid-pass server-side; `zoom`/`cap_stack` no longer persist; **V1 idle race (§6)**. |
| disparity-scope | ❌ renderer-bound; **gated on the stream hot-path thread** (§8). |
| calibrate-* | ❌ renderer-bound; rely on the handoff glue (RT1, §6). |

**Hardening applied** (correctness pass C1–C9, details in git history):
close-race awaiting; dispose-before-force-close + guarded polls; telemetry
snapshot seeding; sink-throw isolation; rect clamping; pending-RPC rejection
on orchestrator death; volt-telemetry throttle; diagnostics to renderer
consoles; echo-skip; controller enable ownership. **C10 deferred** (per-
frame-topic interest; needs a wire addition — bundle with shm/observability).

**Gates (re-verified by planner 2026-07-03):** `vue-tsc --noEmit -p
tsconfig.json` → **0 errors** (the old 3-error `Frame|null` baseline cleared
by the manual-control migration). Orchestrator bundle **93.5 kB, zero Vue
symbols**. `vite build`'s only failure is `RemoteCanvas.vue`'s pre-existing
top-level `await` (the `lib/store.ts` one is gone since store-hub). Type
gates catch shape errors only — every item below still needs its named GUI
check.

## 6. Runtime verification & findings

The app ran once end-to-end (first-run fixes are folded into §3's hard
rules). **Everything landed since — F1/F3, observability, store-hub,
manual-control + capture/record — is GUI-unverified.**

### RT1 — renderer→orchestrator camera handoff race (mostly closed)

`<suspense>` runs the incoming module's async setup (session subscribe →
camera acquire) *before* the outgoing renderer-bound module unmounts and
releases its cameras; `arv_camera_new` then fails cross-process (3× "Failed
to create camera object"), and un-retried activations stayed dead
(`ready: false`) until re-entry. Full analysis in git history.

- **F1 ✅ (✓ verified):** `retryUntil` bounded backoff wraps every
  camera-owning activation (tracking's whole match pass; single-capture /
  manage-cameras per-acquire). Residual: `manage-cameras.refresh()`'s single
  enumeration can transiently miss a mid-release camera (no sticky state).
- **F3 ✅ (✓ verified):** `acquireMany` + role-match-without-opening via
  widened `cameraConfigPath`; cold triple = 2 discovery passes (was 4), warm
  = 1. Not yet profiled against `applyStoredConfig`/`loadConversions` (needs
  GUI session).
- **F2 (symmetric handoff) — open, deprioritized:** F1 closes the
  correctness gap; F2 would only make the fast path deterministic. Dies with
  the last renderer-bound camera module anyway.

### Planner review of the coder pass (2026-07-03)

Claims checked against code; gates re-run independently (both hold). New
findings:

- **V1 🔴 — idle-during-capture/recording lease race. ✅ Fixed (coder,
  2026-07-03).** `idleSession` is now async internally (`idleSessionAsync`,
  fired via `void`): it stops the actuation loop and nulls `triple`
  immediately (so anything checking `getTriple()` mid-drain sees "not
  ready" instead of racing it), then `await Promise.all([recording.stop(),
  capture.waitIdle()])` **before** disposing the `onView` taps or releasing
  leases. `capture.ts` gained `waitIdle()` (resolves once any in-flight
  `run()` completes, immediately if idle) by tracking `run()`'s promise in a
  closure variable. The old triple reference is captured in a local
  (`releasing`) before `triple` is nulled, so a fast resubscribe-during-drain
  reassigning `triple` can't cause the drain to release the *new* leases
  instead of the old ones. **Ordering subtlety that made this non-trivial:**
  the `onView` taps must stay live *during* the drain, not be disposed
  first — a capture can be blocked awaiting the *next* center-view tick
  (`capture.onCenterTick`/`requestCenterView`), so disposing them before the
  drain would deadlock `waitIdle()` forever instead of racing a released
  camera. `vue-tsc` (0 errors) and orchestrator bundle (Vue-free, 92.76 kB)
  re-verified after the fix. Not yet GUI-verified — no hardware in this
  environment; still needs the mid-capture/mid-recording leave-module check
  from item 1's list below.
- **V2 minor — `Ctrl+Shift+I` inspector toggle** collides with the DevTools
  chord on Windows/Linux (fine on macOS where DevTools is `Cmd+Opt+I`).
  Revisit if anyone develops off-mac.
- **V3 trivial — `FrameMeta.tCapture` fallback. ✅ Fixed (coder,
  2026-07-03).** Corrected the doc comment in `protocol.ts` — it now says
  `Channel.sendFrame` defaults unset `tCapture` to its own call time, which
  precedes `tPublish` when a frame sits gated, rather than claiming it
  equals `tPublish`. Code was already correct; only the comment was wrong.

## 7. Roadmap

**Reordering (2026-07-03):** hardware-in-the-loop verification is **deferred
several rounds** while mechanical work on the rig completes (user
direction). Until then: keep landing hardware-free work, and build the perf
infrastructure so that when the verification session finally runs it
produces *quantitative baselines* (the §5.4 latency claim, the zero-copy
gate) instead of only eyeballed streams. The session unit-test harness is
promoted to the compensating control for the growing unverified pile.

### 7.1 Active queue (hardware-free)

**Landed & planner-✓ verified (2026-07-04 review round 3 — gates re-run
independently: vue-tsc 0 errors; `vite build` fully green, a first for this
refactor; orchestrator bundle 102.7 kB, zero Vue symbols; vitest 28/28):**
- **Perf substrate** (§7.3, all four code items) — loop-lag probes both
  processes, control-path latency telemetry, Channel `stats()` counters,
  `system.perfSnapshot` + renderer snapshot dump.
- **Session unit-test harness** — vitest (new devDependency), `app/test/`,
  5 suites/28 tests over real `Channel`/`ServerSession`/`Hub` via
  `fake-endpoint.ts`: store-hub, lifecycle, backpressure gate + C10,
  manual-control capture (incl. the V1 regression), tracking retry (incl.
  the RT1 scenario). `npm test` runs it. Gap: no suites yet for the perf
  substrate's own telemetry (needs fake timers).
- **C10** — `finterest` wire message; sessions skip `sendFrame` for
  uninterested channels (but see **V4** below).
- **`RemoteCanvas.vue` TLA fix** — root cause was the *plain* `<script>`
  block's top-level await (Vue transforms `<script setup>` awaits safely;
  plain blocks it can't) — worth remembering as a hard rule.
- **V1 fix ✓** — `idleSessionAsync`: `triple = null` first (new activity
  sees not-ready), `await Promise.all([recording.stop(),
  capture.waitIdle()])`, then dispose/release. Harness-covered.
- **Tracking refactor-back ✓** — session now on shared
  `leaseCalibratedTriple`/`startActuationLoop`; kinematic predict moved
  into the `targetVolts()` callback (same effective timing).

**V4 🔴 — one-shot frame topics never reach a late-opening ref. ✅ Fixed
(coder, 2026-07-04).** Capture previews are published exactly once
(`manual-control/capture.ts` `deps.frame(...)` at store time), but the
renderer opens `session.frame("capture:<name>[#i]")` only after
`capture_meta` telemetry renders the preview UI (`src/capture/index.vue`) —
latent since the manual-control migration, never caught because capture had
never run under the orchestrator; C10 turned it from "client silently drops
an early frame" into "server doesn't even attempt the send."
- **Fix, exactly as specced:** `ServerSession` gained a `frameCache:
  Map<topic, FramePayload>`, written unconditionally on every `frame()` call
  (before the interest check, so it captures even sends nobody currently
  wants). `Channel` gained `onFrameInterest(fn)` — a plain listener set fired
  from the `finterest` dispatch case alongside the existing
  `frameInterest.add()`. `ServerSession.attach(ch)` registers one: on a new
  interest declaration, look up the cache and `ch.sendFrame` it straight to
  that channel if present (a targeted replay, not a re-broadcast to
  everyone). Cache cleared in both `unsubscribe()` (last subscriber leaving)
  and `dispose()` — bounded by activation lifetime, not topic count, since
  capture's dynamic per-name/per-index channels could otherwise accumulate
  across many capture passes.
- **Harness suite landed** (`test/frame-replay.test.ts`, 4 tests, exactly
  the spec's two cases plus two more): publish-then-interest replays the
  cached frame; interest-then-publish still works normally (didn't break
  the live path); idle clears the cache (a subsequent late interest gets
  nothing); `dispose()` also clears it. `vue-tsc` 0 errors, orchestrator
  bundle Vue-free (104.25 kB), vitest 32/32.
- **Not yet GUI-verified** — same as everything else this round; this fix
  in particular has never seen a real capture pass with a real renderer
  watching, only the harness's synthetic publish/interest ordering.

**Queue now — STAGE 2 (user direction, 2026-07-04).** Five goals; this
also **resolves the disparity-gate question by fiat**: goal S1 requires
migrating disparity-scope, superseding the wait for hot-path-thread
confirmation (coordinate at file level if that thread revives; carry its
buffer-reuse discipline). The **commit checkpoint recommendation stands** —
strongly prefer committing the current all-green tree before Stage 2 lands
on top. Assignments: orchestrator thread S5 → S4 → S1a → S1c → S1b;
synced-capture thread (otherwise idle until hardware) S2 → S3 → P3.1d.

- **S1 — Eliminate all `core` imports from the renderer.**
  Acceptance: zero *runtime* `core` imports reachable from the renderer
  bundle (type-only `import type` is fine — it erases); verify by grep
  *and* by the renderer bundle containing no `.node` loader. Sub-items:
  - **S1a disparity-scope** (the §1 flagship): port `control_task` +
    `vergence.ts` PID onto the proven substrate (`leaseCalibratedTriple`,
    `onView` frame-driven vision, `startActuationLoop`); thin client over
    the existing `modules/disparity-scope/contract.ts` (written back in
    Step 2 — revalidate it against what tracking/manual-control taught us
    before building on it). Harness suite for the vergence math with
    synthetic frames.
  - **S1b calibrate-*** (intrinsic, extrinsic, distortion, drift): one
    session per module reusing manual-control's capture patterns; marker/
    checker detection (`core` MarkerDetector etc.) moves session-side,
    detections cross as telemetry/frames. Largest chunk; module-by-module,
    each landing type-clean + harness-covered.
  - **S1c renderer sweep** (after S1a+S1b): make `StreamView`
    payload-only (delete stream/camera modes + their `Frame`/`Log`
    imports); retire `lib/camera.ts`'s renderer loaders + `Cameras`
    singleton + the RT1 handoff glue (`releaseCameras`/`useCameras`) —
    no renderer camera users remain; drop `src/index.ts`'s `beforeunload`
    `core.cleanup`; quarantine `playground/` (dev-only — exclude from the
    build rather than migrate); sweep remaining runtime imports in
    `lib/{marker,imgproc,mat}.ts` toward type-only or orchestrator-side.
    This unblocks §7.2 "tighten the surface" (`contextIsolation`).
- **S2 — Orchestrator as the *sole* owner of store files.**
  Today store-hub is the only *cross-process* path, but two orchestrator
  files still hit the fs primitives directly, bypassing the hub's cache +
  notifications: `orchestrator/calibration.ts` and `orchestrator/camera.ts`
  (found by grep — the two `@orchestrator/store` imports outside the hub).
  Reroute through store-hub; then make `store.ts` module-private to the
  hub (export nothing else; enforce with a lint rule or a
  `store-hub`-only re-export). Acceptance: exactly one importer of
  `store.ts` in the tree; renderer has zero file-path knowledge.
- **S3 — Recorder on its own thread.** Design decision (spec'd, coder
  implements): keep stream iteration + `frame.raw` extraction on the
  orchestrator main loop (it owns `core`; iteration off already-arrived
  frames is cheap), move **packing/compression/manifest/disk I/O** —
  `stream-writer.ts` — into a `worker_threads` Worker fed by
  **transferred `ArrayBuffer`s** (same-process transfer is legal, unlike
  `MessagePortMain`; zero copy). No `core` import in the worker → the
  NAPI-in-worker risk (§5.1) is avoided entirely, and the worker is
  trivially Vue-free. Bounded in-worker queue; overflow reported via
  telemetry (recording wants lossless — size the queue generously and
  surface drops loudly rather than silently blocking the control loop).
  Build detail: a third Node build entry (or Vite worker output) for the
  utilityProcess worker — mind the `isExternal` externalization rule.
  **Measure the win**: `loopLag` + control-path stats during recording,
  before/after — the perf substrate exists exactly for this.
- **S4 — Profiler window.** A second `BrowserWindow` — this is the
  multi-window plumbing's first real consumer (retires part of the §7.2
  projector risk early, and needs **no cameras**, so it is GUI-verifiable
  during the mechanical downtime). Opened via title-bar button/keybind;
  `main.ts` brokers it its own orchestrator port (the per-renderer
  brokering already exists — first N>1 exercise). Content, all read-only
  over the existing `system` + session telemetry: live sparklines
  (lightweight canvas, no chart dependency) for orchestrator/renderer
  `loopLag`, per-topic channel rates/coalesce ratios, control-path
  latencies, volt telemetry; the S5 startup timeline; a `perfSnapshot`
  export button. Keep it a thin client like any module — no new wire
  concepts.
- **S5 — Debug/startup instrumentation (do first — S4 renders it).**
  Structured timing spans, cheap and always-on: a `span(name)` helper in
  `diagnostics.ts` recording into a bounded ring + broadcast (same
  pattern as `topic.error`). Instrument: orchestrator boot (fork →
  `core` import ms → sessions registered → first port attached),
  per-activation spans (enumerate ms, per-camera open +
  `applyStoredConfig` ms, `loadConversions` ms, **activate → first frame
  published** = "time to live stream"), controller connect. This
  completes RT1-F3's unfinished half ("profile where the remaining
  seconds go") and is the "spin-up time and key parameters accessible"
  ask: visible in the profiler window timeline + dumped in
  `perfSnapshot` + plain console lines behind a debug flag for manual
  verification.

### 7.2 Deferred queue (in order, once hardware returns)

1. **Hardware-in-the-loop GUI session.** ⚠️ Prerequisite unchanged: P3.1a
   must land first (rebuilt `core` + plugged v1 firmware hangs actuation —
   synced-capture §9.3). Checklist, in order of blast radius: store-hub
   smoke pass (every `Store.open` consumer incl. calibrate-*), tracking
   slice (weight the refactor-back!), manual-control incl. capture/record
   + leaving mid-pass (V1), RT1 module-switching, inspector OSD sanity,
   **perf baseline capture (§7.3 item 5)** — run the scripted scenario and
   archive the first snapshot. File findings into §6.
2. Synced-capture bench verification → flash v2 → P5 integration.
3. **disparity-scope migration** (also gated on the hot-path thread, §8);
   finish **R4** alongside.
4. **Multi-window/projector** (C10 will already be in from §7.1).
5. **Zero-copy shared-memory ring** — gated on the §7.3 baseline showing
   the ~2 copies/frame/client matter + a real multi-window consumer.
6. **Tighten the surface** — `contextIsolation` + security hardening;
   unblocked once Stage 2 S1 lands (calibrate-*/disparity migrations are
   now S1a/S1b in the active queue; multi-window brokering gets its first
   exercise early via the S4 profiler window).

### 7.3 Perf substrate spec (prep for verification)

Purpose: the refactor's core claim (§1 — control cadence decoupled from the
render loop) and its costs (frame-copy overhead) are currently
unmeasurable: the inspector OSD covers only the *display* path. Build the
metrics before the session so the first hardware run yields comparable
numbers. Constraints: orchestrator-side code stays Vue-free (`rolling.ts`);
negligible overhead when idle (counters are ints; probes ≤ 1 Hz);
everything additive — telemetry keys + one `system` command, no breaking
wire changes.

1. **Event-loop lag probes, both processes. ✅ Landed (coder, 2026-07-04).**
   `lib/util/rolling.ts` gained `RollingStats` (EMA mean, matching
   `RollingAverage`'s math, plus a plain running max — *not* a decayed max,
   which isn't mathematically coherent; caller-reset via `resetMax()` on
   each publish so "max" means "since the last snapshot") and
   `startLoopLagProbe(intervalMs=200)`. Orchestrator: always-on inside the
   `system` session (it has no `activate`/`idle` — lives for the process),
   published to `system.telemetry.loopLag` at 1 Hz. Renderer: a module-level
   singleton in `client.ts` (`rendererLoopLag`, one probe shared by every
   `StreamView`, not one per instance), read directly (not via a Vue ref) by
   `StreamView`'s inspector `computed` — which already re-runs at frame
   rate off `props.payload`, so no new reactivity plumbing was needed; shown
   as a new "Renderer Lag" OSD line. **Not yet run under induced UI load** —
   that's the actual verification step, still hardware/GUI-session work.
2. **Control-path latency, in-session. ✅ Landed (coder, 2026-07-04).**
   `actuation.ts`'s `onVolts(volt, actuateMs)` gained the timing parameter
   (measured around the single `c.actuate()` call — the two-phase `.accepted`
   split noted here explicitly deferred, since that API doesn't exist until
   P3.1a lands); `manual-control`'s contract/session publish
   `perf.actuateMs` at the existing volt-telemetry throttle.
   `tracking-single` additionally publishes `perf.trackMs` (timed around
   `initTracker`/`updateTracker` inside `onCenterView`) and
   `perf.frameAgeAtActuate` (`now() - lastFrameTime`, where `lastFrameTime`
   is stamped at each real KCF detection, measured inside `targetVolts()` —
   i.e. at actuation time, matching "frame arrival → actuation write").
   `frameAgeAtActuate`/`trackMs` don't apply to manual-control (no tracker),
   so its contract only has `actuateMs`.
3. **Channel/gate counters + C10, sender-side truth. ✅ Landed (coder,
   2026-07-04).** `Channel` gained per-topic `{offered, sent, coalesced,
   bytes}` counters (`stats(topic)`, `allFrameStats()` for the full map),
   incremented at the exact points that already existed for `seq`/
   `tPublish` — `offered` on every `sendFrame` call, `coalesced` when a
   still-pending frame gets overwritten before ever being sent, `sent`/
   `bytes` at the real `postFrame` wire-post. `Hub.frameStatsSnapshot()`
   sums these across every connected channel. **C10 landed in the same
   change**, as planned: a new `finterest` wire message
   (`Channel.declareFrameInterest(topic)` sends it, peers accumulate into a
   `frameInterest` Set); `ServerSession.frame()` now checks
   `ch.hasFrameInterest(t)` before calling `sendFrame` at all, so a session
   subscriber that never opened `frame(name)` for a given topic no longer
   receives it (or pays its stats/backpressure-gate cost). `client.ts`'s
   `frame()` declares interest once, the same place it registers `onFrame`.
   Interest is never "undeclared" — bounded by each session's small fixed
   `frames` list, and the real payoff (a projector window with a narrower
   interest set than the control window) is future multi-window work
   (§7.2 item 4), not observable with today's single-window renderer.
4. **`system.perfSnapshot` command. ✅ Landed (coder, 2026-07-04)** —
   returns `{timestamp, orchestrator: {loopLag}, frames: <Hub.
   frameStatsSnapshot()>, storeHub: <write/update/clear counts>}`
   (`store-hub.ts` gained a `counts` object bumped on every `write`/
   `update`/`clear`, exposed via `writeCounts()`). No git rev field — not
   worth wiring up yet, add if a round-over-round comparison actually needs
   to disambiguate builds. Renderer: **Ctrl+Shift+S** while inspector mode
   is on (`client.ts`) fetches the snapshot, merges in `rendererLoopLag`,
   and writes JSON under `<app data dir>/perf-snapshots/<timestamp>.json`
   via the same `get-data-path` IPC call the old renderer `Store` used to
   resolve its own path. Pick a different chord if Ctrl+Shift+S collides on
   your platform (same caveat as V2's Ctrl+Shift+I note) — not verified
   against any real OS/browser-chrome shortcut table.
5. **Baseline scenario (doc, not code) — still open.** Not written yet;
   do this alongside item 1 of §7.2's checklist when that GUI session
   actually happens (needs real hardware to produce a real baseline, not
   hardware-free work).

## 8. Coordination with parallel threads

**Stream hot-path thread** ([`stream-hot-path.md`](./stream-hot-path.md)):
disjoint by file (they: `core/*` + renderer `disparity-scope/index.vue`).
They preserve the JS-facing stream API sessions depend on; their bounded
async-backlog (`Sub::Queue`) is what makes the concurrent raw consumers in
capture/recording safe. **Touch-point:** disparity migration (roadmap 4)
supersedes the renderer loop they tune — sync before touching their
`index.vue`.

**Synced-capture / protocol v2 thread**
([`synced-capture.md`](./synced-capture.md)): hardware-triggered L/R capture,
mirror position streams, ACK/FIN split. P1+P2+P2.1 done (planner-verified);
P3 (host two-phase `core`) landed **unlogged** — reviewed in that doc's
§9.3, which is its only record. Touch-points:
- `app/orchestrator/controller.ts` + the `controller` session are the shared
  seam; control-loop sessions are the consumers.
- Camera trigger-mode switches go through `registry.ts` `lease.reconfigure()`.
- Frame matching needs per-frame **device** timestamps in the registry sink
  path — extend `FrameMeta` jointly (host-clock fields already exist; the
  device-clock field is theirs).
- **Version-mismatch hazard is two-way until P3.1a lands** (synced-capture
  §9.3): old host + v2 firmware mis-times and WARN-spams; rebuilt (P3) host
  + v1 firmware **hangs actuation** — see the roadmap-item-1 prerequisite.
