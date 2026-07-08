# Extrinsic Calibration

**Seed confidence: MEDIUM. Auditor: confirmed accurate; settle-info suspicion
resolved as NOT-A-BUG for this app.**

## Purpose
Calibrate the mirror/stereo geometry (voltage↔angle conversions + extrinsic
transforms) by collecting marker correspondences across mirror poses while
tracking aruco markers in all three cameras, then fitting the per-fovea
regression records that `orchestrator/calibration.ts`'s `loadExtrinsic`/
`leaseCalibratedTriple` consume. Each record ties, per fovea: marker img/obj
points + mirror voltage (L/R) and the wide camera's angle (C).

## Pipeline (post-real-1f)
Resource-scoped triple session (`defineResourceSession`), acquired via
`matchTriple` (role-matched L/C/R) + the center camera's intrinsic
(`loadIntrinsic` → `undistort`); it deliberately does NOT use
`leaseCalibratedTriple` (that needs the very extrinsic data this tool produces).
Raw L/C/R previews ride `camera:<serial>` pipes (`usePipeFrame`, serials
published via `publishSerials`); marker detection = native `detector.stream` per
camera through `createTrackerTriple` (`internal: true` subpixel). No `onView`
view-tap, no vision worker.

3-step wizard (`state.step`), each switching actuation mode via `enterStep`:
- **CAL** — `startServo(trackers.L, trackers.R, {overrideLeft/Right})`: a
  continuous tracker-driven visual servo keeps the mirrors on the tracked
  markers; the operator can drag-override each mirror.
- **FIN** — no actuation (static review). `finalize` fits both L/R regressions
  (`fitExtrinsicRegression(createDataSet(records, key))`) → `fittedL/fittedR`;
  `finalized` telemetry gates "Preview Results".
- **PRV** — `startActuationLoop` driving both mirrors to `previewVolt`, a
  drag-computed target, to test the just-fitted regressions.

Records persist to a scratch store path across steps/restarts (`persistRecords`),
and `confirm` writes the final per-fovea datasets to the real
`calibrate-extrinsic` store paths (keyed by fovea camera key).

## UI & controls
`index.vue`: CAL shows three previews with marker-corner overlays,
`MarkerTargetInputs` per role, `PosView` drag targets for L/R mirror override
(with `Line2D` history of recorded voltages), and Capture/Clear/Finalize plus a
records list (angle per record, remove button). Wizard step is URL-addressable
(`?step=`). FIN renders SVG-only polygon overlays of each record's img_pts
(bbox-fit viewBox — no images). PRV drags on the center view to test regressions,
showing predicted L/R volts and the round-tripped cursor overlays.
`RemoteCanvasTeleport` draws the physical target markers/crosshair.

## Expected behavior
Detections track markers live; the operator servos/drags each pose and Captures;
fit residuals gate PRV; save updates the persisted extrinsic; `saved` telemetry
reflects the write.

## Known/suspected issues (auditor findings)
- **Detection overlay space (RESOLVED — correct):** overlays are raw-space
  detection points over the raw `camera:<serial>` pipe preview.
- **Step-actuation settle (RESOLVED — NOT a bug here):** `capture()` does NOT
  actuate-then-sample. It samples the CURRENT live state: `activeController()?.pos`
  (the controller's current commanded/predicted volts) plus the three trackers'
  current targets. The servo runs continuously; the operator captures when the
  tracker is visibly locked, so there is no "stepped too early" race. The
  fire-and-forget migration removed the awaited `actuate()` readback, but this
  app never depended on that readback for stepping.
- **Behavioral nuance (RIG-GATED):** under v2 firmware (fire-and-forget), the
  `pos` recorded as a record's `voltage` is the LOCAL predicted volt
  (`predictVolts`), not a hardware-confirmed readback. For calibration this is
  arguably correct (the commanded volt is the reproducible independent variable),
  but confirm on the rig that recorded voltages match measured mirror positions.

## Open questions (for the user)
- Should `capture()` guard against a servo mid-transient (e.g. require the
  tracker target to be stable for N ticks) rather than trusting the operator's
  eye, now that there's no settle-readback? Currently capture is purely
  operator-timed. Left as-is (design choice, not a defect).
