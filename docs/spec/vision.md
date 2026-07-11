# Vision kernels & workers — behavior spec

Behavioral contracts for the orchestrator's vision kernels and worker hosts.
Source pointers are per section; the code carries only load-bearing invariants inline.

## Template-match kernel {#template-match}

Source: `app/orchestrator/template-match-kernel.ts`
(split-disparity-nodes proposal, ruled 2026-07-09)

General-purpose template-match kernel: one `needle` pipe correlated into one `haystack`
pipe — nothing app-specific inside.

- Both inputs arrive pre-sized (ruling 5): a scale node in front of each input owns all
  geometry, so this kernel does NO resizing — the caller computes tile/strip sizing
  (e.g. disparity's `foveaTileSize` / `matchMagnification`) and retunes the scalers.
- Each haystack arrival drives one match tick (the needle is retained across ticks,
  refreshed whenever its pipe produces).
- Output is haystack-local: `rect` (matched needle footprint in the haystack frame's
  pixels) + `score` (CCOEFF_NORMED peak) + `origin` (the haystack frame's frame-bound
  crop origin, forwarded by the slice/scale chain in the v4 slot header).
  `origin + rect-center / <caller's downsample>` lifts a match to absolute source-frame
  coordinates — the kernel never needs a target, and no app state rides its params.
- The emitted `match` heatmap is padded back to the haystack's exact dims (`emitHeatmap`):
  the correlation map is only (sh−th+1)×(sw−tw+1) placement-space pixels, but the sole
  consumer (the debugger's stacked pixel-column cross-reference) needs each heatmap pixel
  (x,y) to be the score of the needle CENTERED at haystack pixel (x,y), so it aligns
  column-for-column with the full-res strip above it. The scalar `values`
  (peak/rect/score) stay computed on the UNPADDED map (placement space).

Used by disparity-scope twice (match/L, match/R); reusable by anything that needs "where
does this tile sit in that stream".

## IMM motion predictor {#imm-predictor}

Source: `app/lib/imm-predictor.ts` (`docs/proposals/imm-delay-compensation.md`)

An Interacting Multiple Model (IMM) Kalman motion predictor chained after the
disparity-scope tracker. The tracker emits target centers stamped with a trusted device
timestamp; by the time the PID/mirrors act on a result the target has moved. This module
wraps each `TrackResult`: it estimates the target's dynamics from the timestamped centers,
then outputs the target's estimated position at `t_result + delayMs` — positive ms
predicts INTO THE FUTURE (lead), negative RETRODICTS into the past (lag). `delayMs === 0`
is an exact passthrough (the same object flows through — zero behavior change until
configured). Pure per-result scalar math (types-only core imports); unit-tested.

### Model set

Three models over a SHARED augmented per-axis state `[pos, vel, acc]`; they differ only by
their transition F(dt) and process-noise Q(dt), so mixing across them needs no dimension
bookkeeping:
- CP constant position — F zeros vel+acc; random-walk position noise.
- CV constant velocity — F zeros acc; white-noise-acceleration Q.
- CA constant acceleration — full kinematic F; white-noise-jerk Q.

Standard IMM cycle per step: mixing → per-model KF predict/update → likelihood →
model-probability update → combination.

### Independent axes, joint gate

Axes are filtered independently (two decoupled scalar-position IMMs). The tracker's per-axis
measurement noise is independent and image-plane motion carries no dynamic cross-axis
coupling, so decoupling keeps every matrix at most 3×3 and explicit; a 2D maneuver is still
captured because each axis detects its own acceleration. The innovation GATE (teleport /
re-arm reset) is evaluated JOINTLY across both axes so a discontinuity in either resets both
— a target teleport moves both filters together.

## Vision worker (host + entry + protocol) {#vision-worker}

Sources: `app/orchestrator/vision-worker.ts`, `vision-worker-host.ts`,
`vision-worker-protocol.ts`, `vision-kernel.ts`

Per-session vision worker: a session-agnostic worker (its own electron build entry,
`.dist/electron/vision-worker.js`) that owns SHM I/O (the reader addon), framing, and the
MessagePort transport; the actual pixel work is a `VisionKernel` it dispatches to by
`params.kind`. Kernels run INSIDE the worker thread — they may use core/Vision + core/Tracker
synchronously (single-threaded loop, no busy-drop dance), one frame at a time awaited
sequentially, so a kernel step is naturally non-reentrant.

READ-ONLY SHM invariant: the worker `reader.open`s the parent-brokered `shmName`s and NEVER
touches the broker/gate. The main-side host (`vision-worker-host.ts`) owns connect/disconnect
(the C-21 gate stays a main-thread-only, race-free single writer): a session on acquire
`connectPipe`s its camera pipes, then `createVisionWorker(...)` spawns the worker with the
shmNames + reader-addon path and pumps params/results over a MessagePort; on release
`terminate()` (tied to the session's ResourceScope). The protocol
(`vision-worker-protocol.ts`) is fork-independent (numbers + transferred ArrayBuffers only,
imports neither core nor the frame transport) so it compiles into both bundles.

## Display kernel + transport {#display-kernel}

Sources: `app/orchestrator/display-kernel.ts`, `display-transport.ts`

The shared DISPLAY vision kernel (calibration-free since C-23) runs INSIDE the vision worker,
producing tracking-single + manual-control's processed views (magnified slice,
perspective-wrapped foveae, combined diff/depth) plus multi-fovea's center relay, off the JS
event loop. Each session computes its calibration-derived matrices on the main thread and
ships them as params (fovea homographies, depth Q-matrix, slice center). real-1g: the C input
is the `undistort:<serial>` pipe — frames arrive ALREADY undistorted from the native remap
producer, so the in-worker `new Undistort(cal)` + the whole cal transport are gone; all
display ops are synchronous. `display-transport.ts` holds the fork-independent, worker-safe
transport types (numbers only).
