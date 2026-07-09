# Capture + recorder everywhere — availability, hang fix, drop diagnosis

Status: **SHIPPED (code-complete 2026-07-09: F1 `5c7c9d4`+`c2c5c43` (core exonerated, test 35), F2 `5c7c9d4`, recording service `09695bb`, capture everywhere `0100bf7`+`6ce3332`; rig pass owed — stage-f §Iteration 2026-07-09)**. Extends
[capture-recorder-nodes](./capture-recorder-nodes.md) +
[multi-fovea-recording](./multi-fovea-recording.md). Two rig findings from
the 2026-07-09 stage-f pass fold in here (they live in this code).

## Intent (user ruling)

Capture and recording are today reachable only from manual-control (capture
+ recording) and multi-fovea (recording). **They should be available
everywhere** — any app.

## Rig findings (fix lanes, same program)

- **F1 — capture preview window waits forever** (user, live rig): after
  triggering a capture, the preview window shows its waiting state
  indefinitely, nothing renders, Save stays disabled. Code review says the
  main-side plumbing is sound (telemetry snapshots ARE seeded to the
  passive window; worker errors settle pending runs) — so the burst itself
  never completes: `grabBurst` blocks on a pipe that never delivers a
  frame. Candidates, in order: (a) the raw L/R taps on live 12p cameras
  (fake camera only ever proved Mono8; the capture worker's FIFO read +
  stack math meet packed 12p here for the first time), (b) the on-demand
  advertise → producer-gate handshake on `camera/<serial>/raw` after a
  prior recording retired the same ids (advertise is NOT refcounted —
  exclusivity rule), (c) the center BGRA slice pipe parked. The worker is
  single-threaded, so a blocked burst also starves `getPreview` — matching
  "nothing is shown". Lane: instrument per-pipe read progress in the
  capture worker (which port stalls), reproduce against a live rig, fix +
  add a burst timeout that rejects the run with WHICH port stalled
  (a hung capture must never require an app restart).
- **F2 — recording drops many frames** (user, live rig): recording
  completes but per-stream drops are high. The accounting invariant is
  pinned (`written + drops == published`), so the numbers are honest —
  the question is WHERE the loss is: recorder queue overflow
  (`maxQueuedFrames`), ring overwrite (reader slower than producer), or
  /zlib compress throughput (bench says a wide 12p stream WILL drop at
  full rate — known). Lane: surface the recorder's per-stream
  `StreamCounters` breakdown live in the recording UI (hover stats exist;
  add drop attribution), capture a perfSnapshot during a rig recording,
  then tune (ring depth / queue cap / disk write batching) against the
  measured bottleneck. The documented compress-only ring-decoupling
  optimization (gate = ring-consumers OR fanout-open) is in scope if the
  snapshot blames the source ring.

## Design (planner recommendation, for ruling at dispatch)

1. **Recording generalizes as a service over adverts.** The recorder is
   already an advert-verbatim socket: any advertised pipe can be recorded
   without interpretation. Lift the per-app recording controller
   (manual-control/recording.ts + multi-fovea/recording.ts, already 90%
   shared shape) into ONE composable `@orchestrator/recording` facility: an
   app session passes {pipe ids, extras binding, path policy}; contract
   mixin gives every app `startRecording`/`stopRecording`/`recordingStats`
   + the title-bar RecordButton and Cmd-R wiring (focused window only).
   Apps opt in by listing which of their nodes are recordable — default =
   their camera/converted pipes.
2. **Capture generalizes the same way but keeps its semantics narrow.**
   Capture's L/R/center stack-and-save is triple-shaped, not generic —
   sessions that hold a calibrated triple (manual-control, multi-fovea,
   disparity-scope, calibrate-distortion/drift/extrinsic) compose the
   capture node via a shared helper + contract mixin (capture command,
   capture_meta telemetry, preview window toggle). Single-camera apps
   (calibrate-intrinsic, manage-cameras) get a degenerate single-stream
   capture (save current full-depth frame) — same UI, one resource.
3. **Exclusivity stays the rule**: capture and recording still share raw
   pipe ids per camera set; the existing refusal semantics extend
   app-agnostically (one recording OR one capture burst per camera set,
   across ALL apps — the registry lease already serializes camera
   ownership, so cross-app races reduce to the existing in-session guard).

## Execution

Lane order: F1 (rig-blocking bug) → F2 (diagnosis + tuning) → availability
(design above, one wave app-side + contract mixins; no core change
expected). F1/F2 need the live rig — instrument first, then user runs, then
fix. Stage-f: the existing capture/recorder sections gain "re-verify after
F1/F2" notes; availability adds per-app smoke items.
