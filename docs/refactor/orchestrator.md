# Refactor: Decouple Orchestrator from Renderer

> **Status:** **Stage 2 committed (checkpoint #2, 2026-07-04). Stage 3
> Rounds 1–3 (T1–T10) and Stage 4 Rounds A+B: all landed and
> planner-verified (Round 3 + Stage 4 verified 2026-07-06).** V5/V6
> fixed in Round 3; the Stage 4 review's V8/V9 seqlock findings were
> fixed the same iteration — the first full dispatch-loop cycle through
> split-of-work.md (dispatch → verify → steer → warm re-dispatch →
> accept). All gates green on the whole tree (vitest 65/65; vue-tsc 0;
> vite build clean; bundles clean; core both runtimes; otool
> system-libs-only; shm native test pass). **The tree is commit-ready:
> checkpoint #3 recommended** (everything since 2bd7b9d — Stage 3
> R1–R3, Stage 4 A/B, contextIsolation flip, docs/workflow).
> Backstory: PB1 (§6, first live session 2026-07-05) showed preview
> transport saturating the orchestrator loop (47 ms mean lag); the user
> greenlit the shm frame path (Stage 4), now canonical for eligible preview
> streams. **Held:** Stage 4 Round C / PB2 (needs display
> + cameras), V7 UI, hardware playbook A–H (mechanical rig).
> Control-plane stays on MessagePort (REST considered & rejected — §4).
> **Dispatch-loop iteration 2 (2026-07-06, post-checkpoint-#3):** A
> landed V7 interactive target placement (+V10 fix); B landed 12-bit
> preview-safe format filtering — **12-bit readout is now code-complete
> end to end** (UI half existed since 06-05; only rig A/B verification
> remains) — and the serial-trace decoder for the P4.1 bench
> (`core/scripts/decode-serial-trace.cjs`). All planner-verified; gates
> 67/67 green. This work is **uncommitted** — fold into the next
> checkpoint.
> **Branch:** `refactor/decouple-orchestrator`
> **Owner:** Yuxuan (plan) / coder threads (implementation). Entries
> marked **(coder)** are reports from an implementing agent; ✓ marks
> planner verification against code.
> **Docs restructure (2026-07-05):** this file and every other
> `docs/refactor/*.md` are now **planner-only tracking** — coders no
> longer read instructions from or write logs into them. The sole
> dispatch/log interface is [`split-of-work.md`](./split-of-work.md)
> (roles, file ownership, active instructions with log-back slots,
> clearing protocol). Instruction blocks below (Round 3, Stage 4)
> remain as the planner's spec-of-record; live dispatch state lives
> there.
> **Last updated:** 2026-07-06 (full step-by-step log in git history)

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
| Zero-copy path | SAB-over-MessagePort is **not implementable** (SAB clones only within one OS process). Real design settled with user 2026-07-05 (post-PB1): **orchestrator-owned `shm_open`/`mmap` segment per stream, triple-buffered** (user picked triple over double+retry; ~19 MB total at 3 cameras), slot header carries seq/`tCapture`/device timestamps; registry's `frame.view("BGRA8", …)` converts *directly into* the active slot (conversion already off-thread → orchestrator JS loop does zero per-frame byte work). Renderer side: **dedicated minimal reader addon in the preload** (single .cpp, libc-only — NOT `core.node`; keeps Aravis/OpenCV out of the renderer process; layout shared via a versioned `ShmRing.h`), requires `sandbox: false`. **V8 memory cage (Electron ≥21) constraint, checked 2026-07-05:** external-ArrayBuffer wrap of mmap memory is banned (crash class, not a risk), and cage memory cannot be made OS-shareable — so true zero-copy into main-world JS is impossible in both directions; the floor is one native memcpy per displayed frame, seq-validated before/after with retry-on-tear. **Handoff correction (2026-07-05):** `contextBridge` *clones* TypedArray arguments, so a bridged `readInto(dest)` cannot fill a main-world buffer — the handoff is a **ping-pong transfer pool**: main world allocates 2–3 ArrayBuffers per view, transfers one to the preload over a dedicated `MessagePort` (the same `window.postMessage`-transfer pattern T5 proved), the addon fills it natively from shm, preload transfers it back. One copy per displayed frame, renderer-side, zero allocation churn, all cage-internal. Doorbell: rAF header-poll (self-coalescing); `Channel` keeps metadata. |
| Contract/RPC | Hand-rolled typed layer: `defineContract` + `defineSession` + mirrored `reactive()` client. |
| Control cadence | Frame-driven (`registry.onView`) or real timers; no rAF server-side. |
| Control threading | **Trackers/PIDs run on the orchestrator JS loop, not dedicated threads** (decided 2026-07-04). Threading lives in the layers around them: firmware owns 1 kHz+ target-following (v2 streams), native C++ threads own acquisition/serial-RX/offline vision (AsyncTask), workers own recorder I/O (S3). Rationale: the §1 problem was sharing a loop with *Chromium*, not the loop model; PID math is µs-scale; threading the tracker forces per-frame Mat copies across thread boundaries + the NAPI-per-worker risk. Known cost: synchronous `tracker.update` stalls the loop a few ms/frame — bounded, measured by `trackMs`/`loopLag`. **Escape hatch (trigger: verification numbers or multi-fovea N-tracker load):** make `tracker.update` AsyncTask-backed in `core` — compute moves to the C++ pool, N trackers parallelize with one Mat copy each, no worker machinery. Session-per-worker + shm frames is deliberately unplanned. |
| Control-plane transport (post-shm) | **Considered REST-over-localhost for everything but frames (2026-07-05) — rejected.** Post-shm Channel traffic is push-dominated (state echo, telemetry, store broadcasts, spans, down-notice, shm doorbell) — REST covers only the RPC slice and forces an SSE/WS rebuild of the rest; a localhost TCP port converts the capability-secured MessagePort into a CSRF/drive-by surface on hardware actuation (webpages can reach localhost); structured clone / TypedArrays / typed contracts / the tested Channel semantics would all be lost or re-proven, for traffic that is kilobyte-scale once frames leave. If external tooling (scripts, curl, remote UI) ever becomes a real requirement, build an **additive dev-gated HTTP facade in front of the Hub** — do not migrate the renderer protocol. |
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
| disparity-scope | ✅ auto-vergence PID + template matching moved onto the registry/`startActuationLoop` substrate (Stage 2 S1a). |
| calibrate-intrinsic | ✅ checker/marker calibration; per-camera picker + live detection (Stage 2 S1b). |
| calibrate-drift | ✅ 3-tracker live drift measurement + servo (Stage 2 S1b). |
| calibrate-distortion | ✅ projector-alignment/homography check (Stage 2 S1b). |
| calibrate-extrinsic | ✅ 3-step CAL/FIN/PRV wizard (Stage 2 S1b) — least-verified item landed this round. |
| multi-fovea | ✅ new module (Stage 3, not a migration): M concurrent KCF trackers off the center free-run + one v2 stream per target + round-robin frame scheduler; harness-tested, live capture Stage-F-gated. V5 stream-create leak fixed in Round 3; V7 🟡 no interactive target placement (§6) remains UI/hardware-gated. |

**Hardening applied** (correctness pass C1–C9, details in git history):
close-race awaiting; dispose-before-force-close + guarded polls; telemetry
snapshot seeding; sink-throw isolation; rect clamping; pending-RPC rejection
on orchestrator death; volt-telemetry throttle; diagnostics to renderer
consoles; echo-skip; controller enable ownership. **C10 deferred** (per-
frame-topic interest; needs a wire addition — bundle with shm/observability).

**Gates (latest planner re-run 2026-07-05, post-Round-2):** vitest
**55/55**; `vue-tsc --noEmit -p tsconfig.json` → **0 errors**; `vite
build` fully green; renderer bundle **zero-core**; orchestrator bundle
**169.4 kB, zero Vue symbols**; `core make build` clean, all runtimes.
Type/harness gates catch shape and logic errors only — every item still
needs its named GUI check (playbook).

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
- **F2 (symmetric handoff) — ✅ obsolete (2026-07-06), closed without
  code.** It was predicted to "die with the last renderer-bound camera
  module" — that happened: since Stage 2 S1 every camera consumer is
  orchestrator-side, so the cross-process acquire-before-release race
  F2 targeted can no longer occur (same-process re-opens are deduped by
  core's refcount registry; module switches move leases, not device
  ownership). F1's `retryUntil` remains as belt-and-suspenders for
  external contention (e.g. a stray process holding a camera).

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

### Perf baseline: manage-cameras frame transport saturation (2026-07-05)

Source snapshot:
[`2026-07-05T19-34-52-251Z.json`](/Users/yuxuan/Library/Application%20Support/fovea-cam-app/perf-snapshots/2026-07-05T19-34-52-251Z.json).

The first real perf snapshot shows the display-frame path, not the
renderer, limiting the observed framerate. `manage-cameras` was streaming
three dynamic preview topics:

- `fr:manage-cameras:24044020` — offered 697, sent 495, coalesced 202,
  bytes 3,079,296,000.
- `fr:manage-cameras:24155467` — offered 698, sent 495, coalesced 203,
  bytes 3,079,296,000.
- `fr:manage-cameras:22071833` — offered 699, sent 493, coalesced 205,
  bytes 3,066,854,400.

Each sent frame is 6,220,800 bytes (`1920 x 810 x 4` BGRA). If the
offered stream is ~60 fps, the sent rate is only ~42.5 fps per camera and
~29% of offered frames are overwritten by the latest-wins backpressure
gate. The renderer loop-lag meter is healthy (mean 0.25 ms, max 1.5 ms),
while the orchestrator loop-lag meter is not (mean 47 ms, max 120 ms).
That points at orchestrator-side preview work and frame transport, not the
Vue/rAF display path.

Current implicated path:

- `registry.ts` converts each native frame to the shared BGRA preview Mat
  (`frame.view("BGRA8", s.view)`) and then calls `toFramePayload`.
- `camera.ts` `toFramePayload` copies that Mat into a fresh `ArrayBuffer`
  with `view.buffer.slice(...)`.
- `ServerSession.frame()` fans the payload to interested channels.
- `Channel.sendFrame()` is behaving as designed: one frame in flight per
  topic, newest pending frame retained, stale pending frame counted as
  `coalesced`.
- `runtime.ts`'s `MessagePortMain` endpoint cannot transfer
  `ArrayBuffer`s, so the transfer list is intentionally dropped and frame
  buffers cross to the renderer by structured clone.

At three cameras, the attempted preview payload rate is roughly
`3 * 60 * 6.22 MB ~= 1.12 GB/s` before clone overhead; the snapshot shows
the current path sustaining about `3 * 42.5 * 6.22 MB ~= 0.79 GB/s` and
coalescing the rest. This is exactly the cost the perf substrate was meant
to expose and is direct evidence for the zero-copy/shared-memory roadmap
gate (§7.2 item 5), with one nuance: the snapshot does not aggregate
`convertMs`, IPC latency, or frame age, so it cannot yet split native BGRA
conversion cost from JS copy/structured-clone cost. The next observability
step should archive per-topic averages for `convertMs`, IPC latency
(`tReceive - tPublish`), and display delay (`tDisplay - tReceive`) so the
copy/IPC/conversion split is visible in exported snapshots, not only in the
live OSD.

Direction: preserve the full-quality preview contract while reducing
unnecessary work. Short-term, propagate active frame interest down toward the
registry/session boundary so the registry does not allocate and copy payloads
for unused topics. Medium-term, pursue the native shared-memory ring design
already locked in §4 once the multi-window/projector consumer arrives;
`MessagePortMain` transfer lists cannot fix this path.

**Planner ✓ (2026-07-05) — numbers verified against the snapshot JSON,
diagnosis sharpened at the cited code.** Anchor: **PB1** (referenced from
the status header and roadmap). Per-topic arithmetic is exact
(`offered = sent + coalesced`; bytes ÷ 6,220,800 = sent for all three
topics; 1920×810×4 confirmed). Corrections and additions to the analysis
above:

- **The native BGRA conversion is *awaited off-thread***
  (`registry.ts:102` — `await frame.view(...)`), so `convertMs` is
  pipeline latency, not JS-loop occupancy. The JS-loop costs per *sent*
  frame are: the 6.22 MB `buffer.slice` copy (`camera.ts
  toFramePayload`), the structured-clone **serialize inside
  `postMessage`** (synchronous on the orchestrator thread), and the GC
  churn of ~0.8 GB/s of short-lived 6.22 MB ArrayBuffers (~127
  allocations/s at the measured send rate). That trio — not conversion —
  is the prime suspect for the 47 ms mean / 120 ms max loop lag.
- **Why this matters more than a display metric: every control loop
  shares this event loop.** A 47 ms mean lag is direct actuation/tracker
  jitter for any session running concurrently with heavy previews. The
  refactor's own premise (§1: don't share a loop with the display
  pipeline) is now being violated *orchestrator-side* by transport work.
  This raises the mitigation priority beyond "preview smoothness".
- **The fps figures are assumption-based, and can't currently be
  computed:** frame counters are per-channel-lifetime with **no window
  timestamp recorded** — and this channel evidently did not span the whole
  session (the spans show tracking + manual-control ran, but no
  `fr:tracking:*` topics appear in the counter map, i.e. the channel was
  reborn at some point). Fix folded into **T10** below: snapshots must
  record counter-window start/uptime so rates are derived, not assumed.
- **Interest propagation would NOT have changed these numbers.** The
  registry already skips payload creation when a camera has no transport
  sinks (`registry.ts:108` `s.sinks.size > 0`), and the measured scenario
  had three *live viewers*. Propagating per-topic `finterest` down to the
  session's registry-sink registration is still right (kills
  produce-without-viewer waste — profiler-only windows, background
  sessions), but the levers that move the *measured* number are: (a)
  smaller preview payloads — downscale-to-display-size and/or fps cap,
  which trades against the stated full-quality contract and is therefore
  a **user decision**, and (b) the shm ring. Nothing in between.
- **Bonus data the section above didn't use — first real spin-up numbers
  (the Stage-2 debug-logging goal, working as designed):**
  `boot.forkToLoad` 348 ms, `boot.firstPortAttached` 1089 ms,
  `camera.enumerate` 1010 ms, `applyStoredConfig` 37–49 ms/camera,
  `session.*.timeToFirstFrame` 2.3–2.5 s, `calibration.matchTriple`
  ~2.07 s — and **two matchTriple spans ran concurrently 40 ms apart**
  (tracking + manual-control activating together), duplicating a 2 s
  discovery pass. Worth an eye in the formal playbook session: module
  switch latency is dominated by matchTriple, and concurrent activations
  don't share it.
- **Incidental but significant: this snapshot is the first live-boot
  evidence for the T5 flip** — produced under `contextIsolation: true`
  via `foveaBridge.writePerfSnapshot`, after a successful port handshake,
  live frames, and a store update (`storeHub.updates: 1`). The formal
  pre-flight click-through still stands, but the flip has survived a real
  session.

### Review of Stage 3 Round 2 worktree (filed 2026-07-05; planner ✓ confirmed against code same day)

Review of the uncommitted tree after T5/T6. Planner re-ran every gate
independently (2026-07-05): vitest **55/55**; `vue-tsc --noEmit` **0
errors**; `vite build` fully green; renderer bundle grep clean of
`core/*` / `MarkerDetector` / `cvtColor` / `convertType` / `Aravis` /
`Regression`; orchestrator bundle (169.4 kB) zero Vue symbols;
`core make build` clean for all Node + Electron runtimes. No GUI/hardware
verification was run. All three findings below are **✓ confirmed real** at
the cited code paths; V5/V6 fix specs were carried into Round 3 (§7.1).

- **V5 🔴 ✓ confirmed in Round-2 review, fixed in Round 3 T8, ✓
  planner-verified 2026-07-06** (generation token checked after every
  awaited `createStream` with immediate close of stale handles; dirty-flag
  do-while rerun replaces the swallowing boolean guard — every stale cause
  coincides with the dirty flag, so coverage is complete; both specced
  harness cases present in `multi-fovea-runtime.test.ts`). Original
  finding: **multi-fovea late stream-create could leak firmware streams.**
  `MultiFoveaRuntime.syncStreams()` (`runtime.ts:160-181`)
  awaits `deps.createStream(...)` and assigns the returned handle with no
  `generation` check — the T6 tokens only guard `updateAsync` completions
  (`runtime.ts:143`). `dispose()` bumps the generation and releases slots
  *while their `stream` is still null*, so a pending `createStream` that
  resolves afterward attaches a live `StreamHandle` to an orphaned slot and
  nothing ever closes it. With v2 firmware that's a `CMD_STREAM CREATE`
  surviving module idle — a consumed stream id and an MCU following a stale
  target. **Planner addition (✓ same review):** the `streamSyncing`
  early-return also silently swallows a `setTargets()` arriving mid-sync —
  newly enabled targets can sit streamless until some later `setTargets`.
  **Fix (one change covers both):** capture a generation token at
  `syncStreams()` entry; after each awaited `createStream`, if the token is
  stale or the slot is no longer live/enabled, `close()` the handle
  immediately and abort; replace the boolean guard with a re-run (dirty
  flag) when a sync was requested while one was in flight. Harness: deferred
  `createStream` resolving after `dispose()` asserts the handle got closed;
  `setTargets` during in-flight sync ends with every enabled slot streamed.
- **V6 🟠 ✓ confirmed, fixed in Round 3 T9, ✓ planner-verified
  2026-07-06** (per-document `enqueue` op chain across read/write/update/
  clear; `notify` carries the exact committed value; both specced harness
  cases present in `store-hub.test.ts`, covering the first-load
  patch-clobber variant too). Original finding: **store-hub cache/echo not
  serialized with persistence.** `store-hub.write()` mutated `doc.value`
  before awaiting
  `fs.write()`, and `notify(doc)` reads `doc.value` at notification time —
  two rapid writes can broadcast B's value on A's completion before B is
  durable; if B's write then fails, clients hold state that never landed on
  disk. The fs layer (`store.ts` `serialize()`) orders the *file* writes;
  the hub's in-memory owner + broadcast are outside that boundary.
  **Planner addition (✓ same review):** `update()` has a worse first-load
  variant — two concurrent updates on an unloaded doc both `await
  fs.read()`; the second read resolution overwrites `doc.value`, silently
  dropping the first patch entirely. **Fix (covers both):** per-document
  op serialization in the hub (chain like `store.ts`'s, keyed on the doc),
  with `notify` capturing the exact committed value for that op. Still
  last-write-wins — no need for `async-reactive.md`'s revision/merge
  design. Harness: interleaved `write`s broadcast only committed values;
  concurrent first-load `update`s lose neither patch.
- **V7 🟡 ✅ fixed (coder A, 2026-07-06), ✓ planner-verified same day** —
  target select + enable, drag-steers-release-commits on the center
  view (commands only: `setTargetEnabled`/`steerTarget`/`placeTarget`;
  nested-state rule honored via `setState` + explicit `applyTargets`),
  per-target colored bbox/index overlays; placement re-inits via the
  `setTargets` release path. Follow-on finding **V10 🟡 ✅ fixed same
  iteration**: stale `updateAsync` completion could override an
  in-progress drag for one frame (same stale-async class as V5/T6) —
  post-await bail now also checks `slot.steering`; harness case added.
  GUI verification rig-gated as usual. Original finding: **multi-fovea
  renderer was not an interactive multi-target surface.** The UI toggles enabled targets and pulse width
  only; there is no way to place per-target centers, so enabled targets
  track from the default `{x: 0, y: 0}` unless state is written externally.
  Fine as the harness skeleton it was specced as — just don't read "M
  center-frame trackers" as a usable workflow yet. **Fix (deferred, not
  Round 3):** center-view click/drag placement per target (tracking-single's
  `onCursor` pattern) — schedule with the first multi-fovea UI round, it
  will want hardware anyway.

### Planner review of Round 3 + Stage 4 Round A/B (2026-07-06)

Round 3 (T8/T9/T7/T10): **all four ✓ verified against code** — see the
V5/V6 annotations above; T7's four suites assert exactly the specced
semantics (throttle cadence, snapshot shape, max/reset); T10's
`window {startedAt, snapshotAt, uptimeMs}` + producer `convertMs` +
renderer `ipcLatencyMs`/`displayDelayMs` land the PB1 observability gap.

Stage 4 Round A/B substrate originally landed behind a byte-identical
switch; that switch was removed 2026-07-06 and shm is now canonical for
eligible preview streams. The coder added a guard better than the spec
asked for: shm engages only
when a serial has **zero `onView` taps**, so Mat-tap sessions keep the
clone path automatically. Reader addon `otool -L`: libc++/libSystem
only ✓. Three new findings, all in the seqlock (steering → Coder C):

- **V8 🔴 — seqlock is missing both fences; a torn frame can validate
  cleanly on ARM64.** Writer (`ShmRing.cpp beginSlot`): the odd
  write-begin marker is a plain `release` store — release orders *prior*
  ops, so the subsequent pixel writes can become visible **before** the
  odd marker; a reader can then copy mid-overwrite while `seq` still
  reads as the old even value on both checks, accepting a torn frame
  undetected. Reader (`ShmReaderAddon.cpp readInto`): the `after` load
  is `acquire`, which orders *subsequent* ops — nothing orders the
  memcpy's reads before the re-check, the mirror-image hole. **Fix:**
  writer — `std::atomic_thread_fence(seq_cst)` between the odd store
  and data writes (one per frame, negligible at 60 fps); reader —
  `std::atomic_thread_fence(acquire)` between the memcpy and the
  `after` load. This is exactly the class C-2's hammer test exists to
  catch; with the fences in, hammer retries should be observed and
  torn accepts zero.
- **V9 🟡 — slot meta is read outside the validated window.**
  `readInto` reads `tCapture`/`convertMs`/timestamps *after* the
  `before == after` check passes — a writer beginning on that slot
  between the check and the meta reads can tear the metadata (pixels
  fine, timestamps from the next frame). **Fix:** copy meta into locals
  between the memcpy and the `after` load; emit the locals only if
  validation passes.

### V11 🔴 ✅ — sandboxed preload broke on the shm preload split (planner hotfix, 2026-07-06)

**First user boot after checkpoint #4 failed** (sandboxed-preload dev run):
`Unable to load preload script … module not found: ./preload-common.mjs`
→ `foveaBridge` never installed → renderer dead at `client.ts`
`onOrchestratorDown`. Root cause chain: (1) Stage 4 split the preload
into two entries sharing `preload-common.ts`; (2) one rollup pass over
multiple entries always extracts shared modules into a sibling chunk;
(3) **sandboxed preloads cannot require sibling chunks** (Electron
sandbox `preloadRequire` allows only built-ins) — and the sandboxed
profiler window runs `sandbox: true` by design. So every
sandboxed window lost its preload. **Fix (planner, direct
— user was blocked live):** eliminated the shared module; each preload
entry now inlines its own hand-synced bridge copy with a KEEP
SELF-CONTAINED banner; `preload-common.ts` deleted. **V11b (same session):** the very next boot
(SHM main-window preload) hit the twin failure — the plugin builds preloads as **CJS
content named `.mjs`** (under `"type": "module"`), which sandboxed
loaders tolerate (require is injected) but the unsandboxed shm window
loads as real ESM → `require is not defined in ES module scope`. Fix:
preload build now emits `format: "cjs"` + `[name].cjs`; `main.ts`
paths updated. **Process lessons:**
(a) `vite build` green cannot catch either failure — new standing
gate: built `preload*.cjs` must contain no relative imports
(mechanical grep, added to split-of-work); (b) my review verified the
SHM path *statically* and the sandboxed profiler path not at all after
the preload restructure — a preload change is boot-path-critical in every
sandbox mode, and only a boot exercises it. The PB2 pre-check now covers
the canonical main window and the sandboxed profiler.

**V11c (user-diagnosed boot, same day):** with .cjs in place the
unsandboxed window still failed — `createRequire(import.meta.url)`
compiles to vite's CJS shim, which resolves via `document.baseURI` in a
preload (preloads have a `document`) → the dev-server http URL →
`createRequire` rejects it. Fix: ambient `require` (the CJS module
wrapper's own), zero `import.meta` in preload sources.
**Final preload architecture (user directive: no hand-synced
duplication):** shared `electron/preload-bridge.ts`, and one low-level
vite-plugin-electron build **per entry** (`preload-renderer.cjs` —
unsandboxed, bridge + shm reader; `preload-profiler.cjs` — sandboxed,
bridge only), each pinning `lib.formats: ["cjs"]` (the plugin otherwise
derives ESM from package `type` and emits it into a .cjs file) and
without a plugin-level `entry` next to `build.lib` (double-builds every
output). **User decision (2026-07-06): `FOVEA_SHM_STREAMS` retired —
shm is canonical.** Main window always `sandbox: false`; registry uses
shm whenever a serial has transport sinks and no `onView` taps
(view-tap serials auto-fall-back to clone); the bridge-clone read
fallback is deleted — transfer-pool failures are hard errors; boot
sweep unconditional.

### V12 🔴 — opening the profiler activates control sessions (mirrors move, shm path lost)

**Live find (user, 2026-07-06, PB2 attempt):** manage-cameras previews at
~60 fps dropped to ~11 fps when the profiler window opened, and the
mirror controllers energized and started moving. Root cause:
`ProfilerWindow.vue` `useSession`s **tracking** and **manual-control** to
display their control-path telemetry; subscription = interest count + 1 =
`onActivate` on *idle* sessions → each leases the calibrated triple and
starts its actuation loop (mirrors move), and their `onView` taps flip
every serial off the shm path (the view-tap auto-clone guard) back into
PB1 clone saturation (11 fps ≈ PB1's 3-camera clone ceiling under extra
load). The old S4 note — "subscribing to camera-owning sessions is safe
by interest-counting" — only held for already-active sessions.
**✅ Fixed (coder A, 2026-07-06), ✓ planner-verified same day —
passive subscriptions:** subscribe payload gains additive
`passive?: boolean`; `ServerSession` keeps observers separate from
active subscribers (state/telemetry/frame-interest flow to both, but
passive never activates/idles resources; passive→active same-channel
upgrade supported; detach-safe). `useSession(contract, name,
{ passive: true })`; profiler observes controller/tracking/
manual-control passively, keeps `system` active (always-on anyway).
Harness: 4 lifecycle cases. **Snapshot evidence (user's two exports,
15:33Z):** profiler-open timestamp = second `controller.connect` span =
counter-window start; tracking + manual-control matchTriple/
timeToFirstFrame with no module open; re-activation waves with
matchTriple degrading 1.1 s → 6.2 s; `convertMs` mean 2.8 → 42 ms
(producer ceiling ≈ 14 fps — the observed 11 fps); both actuation
loops writing the one controller = mirrors fighting. Remaining GUI
check (user): idle app → open profiler → previews hold 60 fps shm,
mirrors parked, no activation in stderr. Side notes from the
snapshots: export from the MAIN window for renderer-side frame timing
(each window merges only its own renderer stats — profiler's is
empty); cameras were at ~1.5 MB/frame vs PB1's 6.22 MB — restore the
PB1 format for the comparison run or file PB2 as a new baseline
environment.

## 7. Roadmap

**Reordering (2026-07-03):** hardware-in-the-loop verification is **deferred
several rounds** while mechanical work on the rig completes (user
direction). Until then: keep landing hardware-free work, and build the perf
infrastructure so that when the verification session finally runs it
produces *quantitative baselines* (the §5.4 latency claim, the zero-copy
gate) instead of only eyeballed streams. The session unit-test harness is
promoted to the compensating control for the growing unverified pile.

### 7.1 Active queue (hardware-free)

**Pre-Stage-2 wave, all landed & planner-✓ verified 2026-07-04 (full logs
in git history of this file):** perf substrate (§7.3 items 1–4); the
vitest session harness (`app/test/` over real `Channel`/`ServerSession`/
`Hub` via `fake-endpoint.ts` — the compensating control for the unverified
pile); C10 `finterest` interest gating; the V1 idle-race fix
(`idleSessionAsync`: null `triple` first, drain capture/recording, then
dispose/release — harness-covered); the tracking refactor-back onto
`leaseCalibratedTriple`/`startActuationLoop`.
- Rule kept from that wave: **top-level `await` is only safe in `<script
  setup>`** — Vue can't transform it in a plain `<script>` block
  (`RemoteCanvas.vue` regression).
- **V4 🔴 ✅ fixed (coder, 2026-07-04):** one-shot frame topics (capture
  previews) never reached a ref opened after publish — C10 made the server
  skip the send entirely. Fix: `ServerSession.frameCache` (written on every
  `frame()` before the interest check) + `Channel.onFrameInterest` targeted
  replay to the newly-interested channel; cache cleared on idle/dispose.
  Harness: `test/frame-replay.test.ts` (4 tests). Never GUI-verified with a
  real capture pass — playbook item.

**STAGE 2 (user direction, 2026-07-04) — status after planner review
round 4 (2026-07-04; gates re-run independently: vue-tsc 0, `vite build`
fully green, vitest 44/44, orchestrator bundle 149.6 kB zero-Vue, renderer
218.6 kB). Full per-module landing logs live in git history of this file.**

| Item | Status |
|---|---|
| **S1a disparity-scope** | ✅ landed, ✓ verified (session registered, vergence/PID server-side, `test/vergence.test.ts` 6 tests). Least-hardware-verified control law in the tree — priority in the rig session. |
| **S1b calibrate-* ×4** | ✅ all landed, ✓ spot-verified. Shared `orchestrator/marker-tracker.ts` (Vue-free port of the old tracker + servo). Genuine pre-existing bug fixed in extrinsic PRV: original called `V2A.predict(angle)` — backwards; now `A2V.predict(angle)` (✓ confirmed at `calibrate-extrinsic/session.ts:222`). Extrinsic wizard = highest-consequence unverified item (closed-loop, 3-step, persistence side effects; mid-wizard resume via scratch store). |
| **S1c renderer sweep** | ✅ substantially landed, ✓ verified: `lib/camera.ts` **deleted**, RT1 handoff glue (`releaseOrchestratorCameras`/`useCameras`) **gone**, `StreamView` payload-only, `playground/` DEV-gated (dead-code-eliminated in prod build, confirmed). **Disclosed exception:** `src/graphics/Marker.vue` still constructs `MarkerDetector` for projector marker *drawing* (1 symbol in built App chunk + the core loader chunk it drags in, ✓ confirmed in build output); `beforeunload core.cleanup` stays until that's resolved. Fix options (deferred): static dictionary data extract, or `pattern(id)` RPC. |
| **S2 store sole-owner** | ✅ landed (coder, 2026-07-04): `orchestrator/{camera,calibration}.ts` now read through `store-hub`; raw `store.ts` is documented as hub-private. Boundary check: only `store-hub.ts` imports it. |
| **S3 recorder worker** | ✅ landed (coder, 2026-07-04): `stream-writer.ts` now owns a `worker_threads` writer fed by transferred `ArrayBuffer`s; worker imports no `core`; format preserved. Harness: `stream-writer.test.ts` covers binary/meta output + queue overflow. |
| **S4 profiler window** | ✅ core landed, ✓ verified (singleton window via `?profiler=1` + dynamic import, own 6.7 kB chunk; `Sparkline.vue`; sections: loop lag both sides, control-path latency, channel rates from `perfSnapshot` diffs, store-hub writes, live S5 span timeline; export button = `dumpPerfSnapshot`). Subscribing to camera-owning sessions is safe by interest-counting (second channel, no re-activation) — objective #2's first real exercise. **Serial/stream probes: now UNBLOCKED** (see queue). |
| **S5 startup spans** | ✅ landed, ✓ verified (`span`/`timeSpan`/`spans`/`onSpan` in diagnostics, 200-entry ring, `topic.span` broadcast, `FOVEA_DEBUG_SPANS` console; boot spans via `FOVEA_FORK_TS`; activation spans: enumerate / per-camera open+config / conversions / activate→first-frame). Completes RT1-F3's profiling half. |

**Rules learned this round (promoted to keep):**
- **Copy-before-await on shared taps.** `onView` Mats are reused buffers —
  derive everything needed *synchronously* before the first `await`
  (identity `resize()` as forced copy where no derivation exists).
  Re-derived independently by disparity tiles, intrinsic checker frames,
  distortion homography warp — it is now a hard rule, not a pattern.
- **`s.setState()` does not fire `watch` hooks** (only client writes do) —
  server-side state changes must invoke the handler explicitly
  (calibrate-extrinsic's `enterStep`).
- **Nested-object state fields must change via commands**, not client-side
  property writes on the nested object (the write doesn't reach the
  server) — calibrate-drift's `setTargetId` pattern.
- **`lib/util/index.ts` is Vue-tainted and radioactive to the
  orchestrator** — three separate regressions this round (`pid`,
  `abortable`, `tracker`'s `clamp`). Vue-free scalar helpers live in
  `lib/util/math.ts`; import from there. The bundle-size gate catches
  this class — check it after adding any orchestrator-side import.
- **`MarkerDetector` consumes raw `Frame`/`Stream` only** — sessions
  needing detection run a second raw-stream consumer alongside the
  registry preview loop (safe: `Sub::Queue` bounded backlogs), with
  explicit Frame refcount bookkeeping (no Vue `watch` doing it
  invisibly).

**Final round complete → commit checkpoint #2 landed 2026-07-04**
(`a49ab0d…b1b2680`: core hardening / firmware ST-64 / stage 2 app / docs).
**The hardware-free runway is drained.** Post-checkpoint audit
(2026-07-05) fixed stale guidance: AGENTS.md's inverted NAPI-in-renderer
pattern + migration status, the superseded planner memory, a stale
tracking-single TODO header, and marked the hot-path gate resolved.
Remaining items:

### STAGE 3 — Multi-fovea groundwork + final surface tightening (Round 1 dispatched 2026-07-05)

**Why this stage:** multi-fovea is the declared purpose of the entire
stream/protocol-v2 infrastructure; its *logic layer* is exactly as
buildable and harness-testable as everything already landed, and it is
the best possible dry run of that infrastructure before hardware returns.
Plus the two small items that finish S1 to 100 %. Same rules as the last
round: scope frozen to the T-items, discoveries logged not fixed, gates
green per item, compact logs (≤ 15 lines). Bench/flash/playbook remain
hardware-gated and are NOT part of this stage.

**Round 1 — orchestrator thread:**
- **T1 — Marker.vue dictionary extraction. ✅ Landed (coder, 2026-07-05),
  ✓ verified — finishes S1: renderer 100 % core-free.**
  `app/scripts/gen-marker-patterns.cjs` dumps "4X4_50" `pattern(id)`
  bit-grids to committed `lib/marker-patterns.generated.ts`; `Marker.vue`
  reads the static table (re-run the script to add a dictionary).
  `src/index.ts`'s `beforeunload core.cleanup` dropped. Along the way the
  CJS-interop re-drag forced replacing `FrameView.vue`'s dead
  `cvtColor` branch with plain-JS `expandToRGBA` — that lesson is
  promoted at the end of Round 1 below. Verified in build output: no
  `core-*.js` chunk, zero `"core` literals or stray Vision symbols in
  `.dist/renderer/assets/*.js`.
- **T2 — `contextIsolation` spike. ✅ Landed (coder, 2026-07-05),
  log-only.** Produced the exact worklist T5 then implemented (bridge
  wrappers, `window.postMessage` port handoff, 5 fs files → IPC,
  `process.nextTick` swap) — superseded by T5's landing record below;
  spike details in git history. Still-unchecked from the spike:
  `serialport`/native-module externals under a *sandboxed* preload
  (sandbox stays off; revisit only if it's ever enabled).

**Round 1 — synced-capture thread (multi-fovea logic layer — all
fake-Device / harness-testable, no hardware):**
- **T3 — round-robin frame scheduler ✅ landed 2026-07-05** (`orchestrator/scheduler.ts`):
  `RoundRobinFrameScheduler` now covers ≤8 in-flight clamping, fair rotation,
  duplicate-REJ tolerance, ACK/FIN timeout→requeue, and per-stream pacing;
  harness: `app/test/scheduler.test.ts`. This satisfies the original
  fake-Device spec over `Controller.frame()` for REJ storms, slow FINs, and
  starvation checks.
- **T4 — `modules/multi-fovea/{contract,runtime,session,index.vue}`
  skeleton ✅ landed 2026-07-05, ✓ verified:** registered session +
  renderer; M center-frame trackers (M ≤ 8 to start, 64 available), one
  v2 stream per enabled target when `v2Capable`, T3 scheduler
  integration, per-target telemetry (angle/volt/stream id/last-FIN age),
  structured capture REJ (`controller-not-connected` /
  `controller-not-v2-capable` / `stage-f-hardware-gated`) until Stage F.
  Harness: `app/test/multi-fovea-runtime.test.ts`. Known limitations:
  V5 stream-create leak found in review and fixed in Round 3; **V7 🟡**
  (no interactive target placement, §6) remains.

**Round 1 ✅ complete — planner-verified 2026-07-05** (54/54 incl. new
scheduler/multi-fovea suites; tsc 0; build green; **renderer bundle now
100 % core-free — no core chunk, zero `"core` literals — S1 acceptance
fully met**; orchestrator 168.9 kB Vue-free). T1's bundle-vs-grep lesson
promoted: *after removing a core import, rebuild and grep the built
assets for unrelated symbols from the same module specifier — the CJS
interop shim re-drags every export of a specifier if any one value
import survives.*

### Round 2 (dispatched 2026-07-05 — T5/T6 ✅ landed & planner-✓ verified same day; T7 rolled into Round 3)

- **T5 — `contextIsolation` implementation. ✅ Landed (coder, 2026-07-05),
  both phases; ✓ planner-verified against code.** `electron/bridge.ts`
  defines `FoveaBridge` (deliberately narrow: path joins + existence/
  writability checks, not a general fs passthrough); `preload.ts` exposes
  it via `contextBridge` (identical under both modes — phase (a) landed
  green with isolation still off, per the DoD). Port handoff exactly as
  T2 specced: preload `ipcRenderer.on("orchestrator:port")` →
  `window.postMessage(..., e.ports)`; `client.ts` listens on the DOM
  `message` event. Phase (b): both `BrowserWindow`s flipped in `main.ts`,
  nothing deleted — one-line revert, and the playbook pre-flight carries
  the first-click-through list + revert clause.
  - **Deeper than the spike flagged (same file set, so not deferred):**
    `vite-plugin-electron-renderer`'s node-builtin polyfill needs a real
    `require`, so even pure `node:path.resolve()` broke — path-join itself
    moved behind the bridge (`resolvePath`), not just I/O.
  - `SavePath.default_path`: sync `existsSync`/`homedir` getter → async
    `ref` seeded from `foveaBridge.resolveDefaultSavePath()`;
    `SaveControls`/`RecordControls` backfill only while untouched
    (`save_path === ""`); `path_valid`/`seq_valid` → `useAsyncComputed`
    (new `lib/util/vue.ts` helper, token-guarded against stale
    resolutions). `lib/store.ts` `process.nextTick` → `queueMicrotask`.
  - **Planner ✓ checks:** flip present on both windows; renderer-reachable
    tree grep-clean of `node:fs`/`node:os`/`node:path`/`ipcRenderer`
    (remaining hits are orchestrator-side session files, correct); the
    retired `get-data-path` handler has zero remaining callers;
    `useAsyncComputed` reads its reactive deps synchronously (tracking
    works); `lib/util/fs.ts` is now main-process-only with exactly one
    importer (`main.ts`). **Not GUI-verified** — the click-through is the
    playbook pre-flight's job.
- **T6 — AsyncTask-backed tracker updates (synced-capture thread, §4
  escape hatch pulled forward). ✅ Landed 2026-07-05; ✓ planner-verified.**
  `core/Tracker.KCF.updateAsync(frame)` via the existing `AsyncTask`
  helper; sync `update()` untouched (tracking-single migrates only after
  measurement). Multi-fovea updates M trackers concurrently
  (`Promise.all`), drops overlapping center ticks (`updating` flag), and
  generation tokens ignore late completions after `dispose()`. Harness
  covers the dispose race. Per-update cost: one full synchronous
  `cv::Mat` copy at argument conversion, before the worker starts.
  - **Planner ✓ checks (the two claims that had to be true):**
    `convert<cv::Mat>` (`core/src/OpenCV.cpp:259`) does a real
    `memcpy` into a fresh Mat — the worker thread never touches
    JS-owned/reused buffers, so copy-before-await holds natively; the
    lambda captures the refcounted `cv::Ptr<TrackerKCF>` by value, so a
    JS-side `release()` mid-flight can't free the native tracker under
    the worker. Full record: synced-capture.md §9.10.
  - **But the lifecycle-safety claim was over-scoped** — it covered
    `updateAsync` only; `syncStreams()` had the same late-completion bug
    for stream creation. **Fixed in Round 3 T8.**

**Round 2 gates (planner re-run 2026-07-05):** vitest 55/55; `vue-tsc` 0;
`vite build` fully green; renderer zero-core, orchestrator zero-Vue
(169.4 kB); `core make build` clean, all runtimes.

### Round 3 (landed 2026-07-05 — coder-verified; planner review pending)

Same round rules as always (scope frozen, discoveries logged not fixed,
gates green per item, logs ≤ 15 lines, tree stays uncommitted until the
user commits). Rationale for a Round 3 before checkpoint #3: V5 is a
known 🔴 in uncommitted code — fix it before it enters history.

- **T8 — V5 fixed:** `MultiFoveaRuntime.syncStreams()` now uses a
  generation guard, closes late/stale handles after awaited `createStream`,
  and dirty-reruns if targets change mid-sync. Harness covers dispose
  while `createStream` is pending and target mutation during in-flight sync.
- **T9 — V6 fixed:** store-hub reads/writes/updates/clears are serialized
  per document, and broadcasts carry the exact committed value from the
  completed operation. Harness covers broadcast ordering and concurrent
  first-load updates.
- **T7 landed:** fake-timer suites cover `system` loop-lag telemetry,
  `system.perfSnapshot` shape/reset behavior, and 2 Hz controller serial/
  stream telemetry cadence.
- **T10 landed:** frame stats now include counter windows/rates plus
  producer `convertMs`; renderer snapshots add IPC latency and display-delay
  rolling timing. Additive shape only.

**PB1 mitigation decision (user, 2026-07-05): shm frame path pulled
forward — see Stage 4 below.** The downscale/fps-cap lever is deferred,
not rejected: post-shm it only affects the renderer-side display copy,
so revisit after Stage 4's PB2 measurement. Per-topic interest
propagation down to registry sinks remains uncontroversial-but-unmoving
for the measured case; fold it in whenever a round next touches the
registry sink path (natural fit: Stage 4 SHM3).

**After Round 3 the remaining non-SHM tree is hardware-gated.** Held:
V7 (needs a UI/hardware round), formal playbook, bench/flash.

### STAGE 4 — shm frame path (user greenlit 2026-07-05; supersedes §7.2 item 5's gate)

**Why now:** PB1 (§6) showed preview transport saturating the
orchestrator loop (47 ms mean lag — direct control-loop jitter) with a
single window; the design is fully settled (§4 zero-copy row: triple
buffer, minimal reader addon, ping-pong pool); the user waived the
remaining gate. T10 (Round 3) still lands first/parallel so before/after
is measurable, not eyeballed. Same round discipline as every stage:
scope frozen to the SHM-items, discoveries logged not fixed, gates green
per item, compact logs ≤ 15 lines, tree uncommitted until the user
commits.

**Round A (implementation spec — landed 2026-07-05):**

- **SHM-1 — `core` ShmRing writer + layout.** `core/include/ShmRing.h`
  is the single layout authority: segment header {magic, layout version,
  generation, shape (w/h/channels), slot count = 3, slot stride} +
  per-slot {seq (seqlock: odd = writing), meta: tCapture, convertMs,
  deviceTimestamp, systemTimestamp}. Writer API in `core.node`:
  create/regenerate (name `/fv.<serial>.<gen>`, ≤ 31 chars — macOS
  PSHMNAMLEN; slots 16 KB-page-aligned; created lazily on first shape,
  no `ftruncate` resize ever), `writeSlot()` → Mat over the next
  non-published slot so `frame.view("BGRA8", slotMat)` converts
  *directly into shared memory*, `publish(meta)` (seq bump + header
  store), `unlinkAll()` + a `/fv.*` sweep helper. Reader API (same
  header, used by SHM-2 and by tests): open `O_RDONLY`, pick latest
  stable slot, `readInto(ptr)` with seq check before/after + bounded
  retry, stale-generation detection. DoD: `core make build` both
  runtimes; harness (same-process, two mmaps): roundtrip, tearing under
  a hammering writer thread (retries observed, no corrupt reads),
  generation swap while a reader holds the old mapping (stale-but-safe,
  then reopen), sweep removes orphans.
- **SHM-2 — reader addon (separate target, NOT `core.node`).** One .cpp
  + `ShmRing.h`, NAPI surface: `open(name)`, `latestSeq(h)`,
  `readInto(h, buf, lastSeq)` → `{seq, gen, meta} | null` (null = no
  newer frame), `close(h)`. Built for the Electron runtime via
  `make.cjs` as a second target. **DoD includes `otool -L`: system
  libraries only — no OpenCV/Aravis/GLib** (this is what keeps the
  renderer process core-free at the *process* level, not just the
  bundle level). Harness: core writer + this reader in one Node
  process.

**Round B (implementation spec — landed 2026-07-05 behind a flag,
promoted to canonical preview transport 2026-07-06):**

- **SHM-3 — registry integration.** When eligible, `s.view` is the Mat over
  the active write slot; publish = slot meta store + a **descriptor**
  fanned through the existing path — `FramePayload` gains an `shm`
  variant `{seg, gen, seq, shape, channels, meta}` with no `data`
  field, so `finterest`, per-topic seq, stats, and the whole tested
  Channel machinery carry over with the bytes out-of-band. Reconfigure
  → generation bump announced via the descriptor itself + session
  state; boot-time `/fv.*` sweep wired into orchestrator startup. Fold
  in the PB1 interest-propagation nicety while touching the sink path.
- **SHM-4 — preload/bridge reader.** `sandbox: false` on the main
  window only — same two-phase discipline as T5: one-line flip,
  playbook-documented revert; profiler window stays sandboxed. Addon
  loads in preload; handoff is the **ping-pong transfer pool** (§4 —
  contextBridge clones TypedArray args, so the pool transfers over a
  dedicated MessagePort using the T5-proven `window.postMessage`
  pattern).
- **SHM-5 — client/StreamView integration.** `client.ts` `frame()`
  resolves `shm`-variant payloads through the pool on its existing rAF
  tick (latest descriptor wins — coalescing comes free); non-shm
  payloads unchanged (session-computed frames — tracking's fovea/
  processed views — stay on the clone path this stage). OSD gains shm
  columns: read retries, stale-gen reads, generation. Renderer bundle
  stays zero-core (descriptor types are type-only).

**Coder progress 2026-07-05 (iteration 1):** SHM-1/2 native substrate
landed: `core.Shm.Writer`, versioned triple-buffer layout
(`core/include/ShmRing.h`), `Frame.view("BGRA8", ShmSlot)` direct async
write path, and standalone `fovea_shm_reader.node`; `core make build`
passes for Node + Electron, and `otool -L` on the reader shows only
libc++/libSystem (no OpenCV/Aravis/GLib). SHM-3/4/5 first integration
also landed first behind a default-off flag, later removed when SHM became
canonical: registry uses SHM only for transport-only camera previews
(no `onView` taps), `FramePayload` can carry an out-of-band descriptor,
the main window selects a SHM preload
with `sandbox: false`, and `client.ts` materializes descriptors on its rAF
path. The ping-pong transfer pool landed in iteration 2 below. Gates run:
app `vue-tsc`, vitest 56/56, `vite build`,
native SHM smoke test (outside sandbox because `shm_open` is blocked
inside it).

**Coder progress 2026-07-05 (iteration 2):** ping-pong transfer pool
landed in `client.ts`/`preload-shm.ts`: the main world posts a reusable
ArrayBuffer to the SHM preload and receives it back transferred.
The native smoke script now covers roundtrip, generation swap, and a
worker hammer (`core/test/08-shm-ring.ts`); it passes outside the sandbox.
Reader `otool -L` still shows only libc++/libSystem. Renderer/main/preload
bundle grep remains zero-core; orchestrator bundle grep remains zero-Vue.
Final coder gates: app `vue-tsc --noEmit`, app Vitest **65/65**, app
`vite build`, `core make build`, and `core/test/08-shm-ring.ts` all pass.

**Stage 4 design notes after iteration 2:** `/fv.*` orphan sweeping is
not portable on macOS because POSIX shm names are not enumerable; the
writer therefore uses deterministic short names and unlinks its own known
segments on generation/close. Registry inspection found no current session
that needs a separate SHM preview path while also consuming `onView`:
preview-only modules use `onFrame`, processing modules use `onView` and
publish derived frames on the clone path, and calibrate-intrinsic switches
between modes rather than needing both simultaneously.

**Stage 4 remaining after iteration 2:** run Round C PB2 with display +
cameras; planner review; hardware/playbook verification. Downscale/fps-cap
decision remains deferred until PB2.

**Round C (verification — needs display + cameras, NOT the mirror
rig):** re-run the PB1 scenario with canonical SHM, capture an
idle/preview T10 snapshot pair, file as **PB2**. Targets: orchestrator
loop lag **< 5 ms mean** under 3-camera preview; tearing retries ≈ 0;
open a second window on the same serials and confirm ≈ 0 marginal
producer cost. Then decide the downscale lever (renderer-side only by
then) and revisit §7.2 item 5's residuals.

**Out of scope for Stage 4 (explicit):** raw/capture/12-bit frames,
session-computed frame topics (adopt later per-topic if PB2 warrants),
any change to the control-plane transport (§4: REST rejected).

### 7.2 Deferred queue (once hardware returns)

**Execution plan for everything below:**
[`verification-playbook.md`](./verification-playbook.md) — staged A→H,
prepared in advance; run it instead of improvising the session.


1. **Hardware-in-the-loop GUI session.** ⚠️ Prerequisite unchanged: P3.1a
   must land first (rebuilt `core` + plugged v1 firmware hangs actuation —
   synced-capture §9.3). Checklist, in order of blast radius: store-hub
   smoke pass (every `Store.open` consumer incl. calibrate-*), tracking
   slice (weight the refactor-back!), manual-control incl. capture/record
   + leaving mid-pass (V1), RT1 module-switching, inspector OSD sanity,
   **perf baseline capture (§7.3 item 5)** — run the scripted scenario and
   archive the first snapshot. File findings into §6.
2. Synced-capture bench verification → flash v2 → P5 integration.
3. **R4** (leases only via session lifecycle) — the disparity migration
   it was waiting to ride along with has landed (S1a); do it with
   whichever item next touches the registry.
4. **Multi-window/projector** (C10 will already be in from §7.1).
5. **Shared-memory frame path — ✅ promoted to STAGE 4 (§7.1), user
   decision 2026-07-05; no longer hardware-gated** (Rounds A/B are
   hardware-free; Round C needs display + cameras only, not the mirror
   rig). Gate history: was baseline-gated; PB1 met the traffic half
   (~0.79 GB/s clone, 47 ms loop lag, single window) and the user waived
   the remainder. Design fully settled in the §4 zero-copy row —
   triple-buffered orchestrator-owned segment per serial, exact-size +
   generation on shape change, single-writer/multi-reader anonymous
   `O_RDONLY` mappings (zero marginal producer cost per window — what
   makes objective #2's projector pair affordable), minimal preload
   reader addon behind `sandbox: false` on frame-reading windows only,
   ping-pong transfer pool handoff.
6. **Tighten the surface** — ✅ `contextIsolation` landed (T5, 2026-07-05;
   flip verified in the playbook pre-flight when the rig returns).
   Note: with `nodeIntegration: false` and no explicit `sandbox` key,
   Electron ≥ 20 sandboxes the preload *by default* — today's preload
   (ipcRenderer/contextBridge only) is fine with that, but the shm
   reader addon (item 5) will require an explicit `sandbox: false` on
   the windows that read frames. That is a deliberate, documented step
   back from the default, decided with the shm design (§4 zero-copy
   row).

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
5. **Baseline scenario (doc, not code) — partially superseded by PB1
   (§6).** An informal 2026-07-05 session produced the first archived
   snapshot and its analysis; the *scripted, repeatable* scenario is
   still unwritten — write it for the formal playbook run so
   round-over-round numbers compare like-for-like (same modules, same
   dwell times, idle-vs-preview pair per T10's window bookkeeping).

## 8. Coordination with parallel threads

**Stream hot-path thread** ([`stream-hot-path.md`](./stream-hot-path.md)):
disjoint by file (they: `core/*` + renderer `disparity-scope/index.vue`).
They preserve the JS-facing stream API sessions depend on; their bounded
async-backlog (`Sub::Queue`) is what makes the concurrent raw consumers in
capture/recording safe. **Touch-point resolved (2026-07-05):** the disparity
migration (S1a) superseded the renderer loop they tuned —
`disparity-scope/index.vue` is now a thin client; their buffer-reuse
discipline carried into the session per plan. Their doc's remaining value
is the core Stream/Iterator semantics record.

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
