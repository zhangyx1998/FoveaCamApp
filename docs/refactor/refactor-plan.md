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

## WS1 design — open decisions to ratify before WAVE 2
- Publisher-thread **granularity**: per-pipe vs one publisher fanning a
  producer's output to N consumers.
- **Broker mechanism**: how a JS lifecycle request wires the renderer's shm
  handle to the C++ publisher (likely the existing MessagePort/reader-addon path,
  set up ONCE out-of-loop).
- **Contract pipe spec** shape (pixelFormat/resolution/dtype/channels) — the
  typed-pipe schema the renderer selects from; reuse `docs/schema/pixel-formats`.
- **Symmetric close** protocol (producer-side vs consumer-side teardown, and what
  the other end observes — frozen last frame vs explicit closed state).

## Verification
The 2026-07-07 HIL pass surfaced its findings; the refactor rewrites those
surfaces, so `verification-playbook.md` is **paused** — a fresh HIL pass runs
against the new architecture post-WS1. Firmware Stage F/G detail there stays the
reference for WS4's bench/flash.
