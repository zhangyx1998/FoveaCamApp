# Incremental Calibration (Drift)

**Seed confidence: MEDIUM-LOW — auditor derived the delta vs extrinsic.**

## Purpose
Measure and persist the small per-fovea angular offset between "where the
extrinsic regression predicts the wide camera should see the marker" and "where
it actually appears" — a light-weight drift correction that does NOT redo the
full extrinsic fit. It writes `drift_l`/`drift_r` (a `Point2d` angular offset per
fovea) into the triple's own config (`triple.configPath`), which the servo's
origin then applies as a correction.

## Pipeline (post-real-1f)
Resource-scoped triple session acquired via `acquireTriple` (a
`CalibratedTriple`: leases + `undistort` + `conv` A2V/V2A + `configPath`) — so,
unlike extrinsic, it REQUIRES existing calibration. Raw L/C/R previews ride
`camera:<serial>` pipes; marker detection = native `detector.stream` via
`createTrackerTriple` (no `internal` subpixel here). Shares the marker-calibration
substrate with calibrate-extrinsic (`createTrackerTriple`/`detectionViews`/
`retarget`/`stopTriple`), but has **no wizard steps** — one continuous mode.

A single background `startServo(trackers.L, trackers.R)` runs continuously with
`kp:10.0` and per-fovea `originLeft/Right` = `conv.A2V(applyDrift(centerAngle,
saved))` — i.e. the servo aims each mirror at the center-observed angle plus the
currently-saved drift, so the operator watches convergence live. `override_left/
right` still take priority.

Drift derivation: `deriveDrift(fovea) = centerAngle − fovea`, where `fovea` is the
mirror's current actuated angle (`conv.V2A(activeControllerPos())`) and
`centerAngle` is the wide tracker's `angular(centerAbsolute)`. A 200 ms timer
publishes the live `derived` drift (it needs the actuated mirror position, which
only changes on the servo's own tick, so it can't ride tracker ticks).

## UI & controls
`index.vue`: three previews with marker-corner overlays and `MarkerTargetInputs`;
per fovea a `Drift` readout of derived + saved drift and a `PosView` mirror
override; center column has Update Drift (L / All / R) buttons (commit `derived`
→ persisted config) — each disabled until its derived drift exists.
`RemoteCanvasTeleport` draws the target markers/crosshair; a Drawer exposes marker
size/ratio. `PosView`/controller state read directly via `useController`.

## Expected behavior
Markers track live; the servo converges each mirror onto the drift-corrected
target; `derived` updates ~5 Hz; committing writes `drift_l`/`drift_r` and updates
`saved`; clearing nulls the chosen fovea's drift. Persisted drift is picked up by
any consumer reading the triple config.

## Known/suspected issues (auditor findings)
- **Settle-info (RESOLVED — NOT a bug here):** same as extrinsic. `updateDrift`
  reads the CURRENT `activeControllerPos()` (continuously updated by the servo),
  not a stepped-then-awaited actuate. The fire-and-forget change removed the
  awaited readback but this app never stepped-and-sampled; it samples live
  continuous state. Under v2 firmware `activeControllerPos()` is the predicted
  volt — confirm on the rig that derived drift matches reality (RIG-GATED).
- `updateDrift`/`clearDrift` role logic verified: `L` touches only L, `R` only R,
  `ALL` both (the `role !== "R"`/`role !== "L"` guards are correct).

## Open questions (for the user)
- The `derived` drift depends on the servo already pointing near the target (it
  uses the actuated mirror angle). If the servo hasn't converged, `derived`
  reflects transient error. Should Update Drift require convergence (e.g. small
  residual) before it will commit, or is operator judgement sufficient? Left
  as-is.
