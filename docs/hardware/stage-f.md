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

## Blocked (hardware change required)

- [ ] **Center-camera hardware trigger** — needs the slimmer CAM0 cable
  (`rig.md`); until then C free-runs and center captures are one-shot pipe
  reads.
