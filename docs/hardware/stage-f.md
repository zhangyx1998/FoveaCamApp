# Stage-F — the living rig checklist

Items that are **code-complete but only verifiable on hardware** (live
cameras + a v2-flashed controller). Swept from RIG-GATED / RIG-VERIFY markers
across the app docs and refactor-era commit messages at round close
(2026-07-08). Check items off here as rig sessions confirm them; each line
names the mechanism it gates.

## Serial / actuation (v2 firmware)

- [ ] **predictVolts accuracy** — compare locally predicted volts against a
  sampled real `Actuate` readback; confirms the firmware ECHOES commanded
  channels (streamed telemetry correctness). `orchestrator/controller.ts`.
- [ ] **FW5 coexistence** — streamed actuation + CMD_FRAME captures together:
  no `Streams::snapshot` corruption, FIN voltages sane.
  `orchestrator/actuation.ts` + `scheduler.ts`.
- [ ] **Serial rate** — `controller:<port>` packets/sec in the profiler at
  target (kHz-class) with the loop freed + fire-and-forget streaming.
- [ ] **FIN exposure voltage** — live FIN↔frame pairing: recorded
  `volt.source: "fin-averaged"` bound to the exact triggering frame
  (`recording.ts`); calibrate-extrinsic's v2 recorded-voltage=predicted-volt
  nuance.
- [ ] **Frame scheduler** — `scheduler.start()` pumping CMD_FRAME on live v2
  hardware (returns null / parked on v1); multi-fovea per-target imagery
  (`fovea:` tiles) once wired.

## Vision / streams

- [ ] **Worker vision parity** — all migrated apps' vision (per-session
  worker kernels) visually match the pre-migration output; fps recovery
  confirmed in the profiler (registry:* gone, converters busy).
- [ ] **Composed multi-fovea** — live multi-target tracking quality +
  composed-fovea preview (renderer-composed nodes, native multi-KCF).
- [ ] **Undistort producer calibration** — B's native remap uses the intended
  camera matrix (`mtx` via `initUndistortRectifyMap`, not an alternate) —
  manual-control residual.
- [ ] **KCF arm-in-raw-space** — tracking-single: native KCF armed from
  drag-end + the on-screen box on the wide view (user-reported bug fix).
- [ ] **Disparity-scope magnification** — absolute magnification (~9×
  expected) + match_left/right quality with the measured fovea↔wide scale
  ratio; projection-plane bake-in check.
- [ ] **Calibrate-drift derived volt** — derived drift matches physical
  reality.
- [ ] **12-bit readout A/B** — live capture in each listed 12-bit format
  (code-complete end to end; preview-safe option filtering).

## Platform

- [ ] **Freeze-gone re-check** — manage-cameras preview marathon (the old
  transfer-pool GC freeze class) on the current pipe path.
- [ ] **V12 live check** — opening the profiler mid-tracking: mirrors keep
  moving, SHM previews unaffected.
- [ ] **HIL re-baseline** — export a fresh profiler snapshot set (pre-flight
  + PB2) against the post-refactor architecture for the record.

## Hardware quiescence (safety invariant, fixes of 2026-07-08 rig finds)

- [ ] **App-switch reopen race gone** — exit manual-control → enter another
  triple app repeatedly: no `Failed to restore pixel format … access-denied`
  in the orchestrator log (registry awaits the pending close + retries the
  config apply across the acquisition-stop window).
- [ ] **No more exit-6 aborts** — the same switch marathon never ends in
  `libc++abi: terminating due to uncaught exception of type Napi::Error`
  (core now builds with `NODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS`).
- [ ] **Graceful-quit quiesce** — quit the app with MEMS enabled + streams
  live: orchestrator log shows the drain, the device echoes `MEMS Disable`,
  and the next boot's config restore succeeds first try.
- [ ] **Crash janitor** — `kill -ABRT` (or -9) the orchestrator mid-tracking:
  main logs `[janitor] launching…`, the device echoes `MEMS Disable`,
  `[janitor] camera <serial>: acquisition stopped` for each streaming camera,
  and relaunching finds no locked camera (config writes succeed).
- [ ] **Disconnect disables** — title-bar controller disconnect while
  enabled: device echoes `MEMS Disable` before the port is released.

## Round-2 fixes (2026-07-08, commit 6bd5794) — ⚠ FLASH FIRMWARE FIRST (`cd firmware && make upload`)

- [ ] **Mirror follows streamed targets** — manual-control drag: the physical
  mirrors track the commanded position (firmware fix: CREATE auto-activates
  the DAC-driving stream; previously only CMD_FRAME captures activated one —
  mirrors stayed at origin).
- [ ] **Pipeline graph renders** — every app shows its node graph; snapshot
  export saves and the folder button reveals the file (perfSnapshot no longer
  rejects on live converter/tracker probe rows).
- [ ] **Stream update rate at input rate** — dragging in manual-control shows
  `controller:<port>` packets and the per-stream Hz well above 60 (device
  polling rate via pointerrawupdate; wire path is kHz-capable).
- [ ] **fps ceiling** — with the graph live, read the CAMERA node's output
  rate: if it's already 30, the cap is stored config (manage-cameras
  frame_rate / exposure > ~16 ms), not the pipeline; 4-buffer stream slack
  landed either way.

## Unified time (proposal P1/P2, 2026-07-08) — ⚠ FLASH v1.1 FIRMWARE FIRST

- [ ] **TimestampLatch support** — check each camera model accepts
  `TimestampLatch`/`TimestampLatchValue` (profiler Clocks panel shows
  `method: latch` per `camera:<serial>`; a missing row + "TimestampLatch
  unavailable" diagnostic = fall back decision needed). Confirm the latched
  value's UNIT (assumed ns).
- [ ] **Controller ping** — with v1.1 flashed: Clocks panel shows
  `controller` row, jitter well under 500 µs; `readTimestamp` on OLD
  firmware times out gracefully (3 s) instead of wedging connect.
- [ ] **Offset sanity** — camera and controller offsets stable across
  reconnects (± jitter); re-calibration after sleep/wake.
- [ ] **Mirror history** — during streamed actuation, `mirrorAt` age stays
  ~1 tick (no gaps) — observable once the fovea homography consumes it.

## Unified-time FINAL + brick chain (2026-07-08 close, through 77d4afb) — ⚠ FLASH v1.1 FIRST

- [ ] **Owner-thread calibration live** — profiler Clocks section fills
  within seconds of camera open (method latch, jitter ~50–150 µs matches the
  bench smoke) and driftPpm appears after the first 30 s drift re-run;
  re-calibration updates rows mid-task. TimestampLatchValue ns assumption
  per model (RIG-CHECK in ClockCalibration.cpp).
- [ ] **Trusted-time end-to-end** — recorded/paired timestamps (camera
  frames vs FIN tTrigger/tExposure, now both host-ns) agree to ~ms; sync.ts
  deltas collapse to trigger-path latency.
- [ ] **Chained bricks visual parity** — center undistort (now chained on
  the shared converter) matches the old fused output; fovea crops on the
  undistort chain; graph shows camera → convert → undistort → fovea with
  real edges + tx/rx/drop labels.
- [ ] **L/R homography orientation** — the OPEN QUESTION in
  homography-feeder.ts: conv.A2H H vs its inverse/wide-frame composition;
  wrong guess = harmless warp, passthrough meter names it. Verify + fix the
  seam in one place.
- [ ] **Enable no longer resets MCU clock** — calibration survives
  enable/disable cycles (v1.1 behavior change).

## PID nodes + view re-plumb (2026-07-08 wave, through 9217523)

- [ ] **View fps decoupled** — disparity-scope / tracking-single /
  manual-control / calibrate-distortion: L/R (and disparity's C) main views
  render at CAMERA rate while the kernel meters lower (the 36–40 vs 60 fps
  gap closes); profiler graph shows the undistort nodes in every chain.
- [ ] **Disparity chain renders** — camera→convert→undistort→scope→pid→
  controller in the graph; scope node meters only analysis work (no view
  relay traffic on its edges).
- [ ] **Undistorted-view alignment** — disparity's overlays (target dot,
  pose rects, tracker bbox, match rects) align on the undistorted C view;
  L/R undistorted views track mirror pose via the feeder (no wrap toggle
  anywhere anymore). RIG-CHECK (pre-existing): feeder H vs inverse — one
  seam in homography-feeder.ts.
- [ ] **Override semantics live** — disparity drag: mirrors follow, release
  resumes vergence control from the released pose with NO jump (seeded
  reconstruction inverse). calibrate-drift / calibrate-extrinsic per-eye
  drags: dragged eye pins (controllers held reset), other eye keeps
  servoing; release resumes from the released pose (old behavior snapped).
- [ ] **Servo numeric parity** — calibrate-drift/extrinsic marker servoing
  converges exactly as before (PID2D velocity form is bit-identical on the
  bench; confirm no felt difference on hardware).
- [ ] **Capture wrap default** — manual-control captures always save
  WRAPPED foveae now (the retired toggle's default); confirm downstream
  consumers of recorded captures expect this.

## Blocked (hardware change required)

- [ ] **Center-camera hardware trigger** — needs the slimmer CAM0 cable
  (`rig.md`); until then C free-runs and center captures are one-shot pipe
  reads.
