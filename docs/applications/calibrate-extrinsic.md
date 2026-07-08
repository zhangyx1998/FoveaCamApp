# Extrinsic Calibration

**Seed confidence: MEDIUM.**

## Purpose
Calibrate the mirror/stereo geometry (voltage↔angle conversions + extrinsic
transforms) by stepping the mirrors through poses while tracking aruco markers
in all three cameras, collecting correspondences, and fitting the conversion
records (persisted extrinsic records; `triple.conv` A2V/V2A consumers).

## Pipeline (post-real-1f)
Triple session; raw previews via `camera:<serial>` pipes (usePipeFrame);
marker detection = native `detector.stream` per camera (createTrackerTriple);
step state machine (`enterStep`) drives servo/preview actuation; records
collected → fitted (fittedL/fittedR) → save. No vision worker needed.

## UI & controls
Target id select per role, step progression UI, override_left/right nudges,
records table, save/finalize, detection overlays on previews.

## Expected behavior
Detections track markers live; stepping sweeps poses; fit residuals reported;
save updates the persisted extrinsic; finalized state reflected in telemetry.

## Known/suspected issues
- Verify detection overlay coordinate space matches the raw preview.
- Step actuation now rides the fire-and-forget stream — verify settle waits
  (predictVolts has no completeTime; steps that awaited actuate() settle info
  may need the sampled path).

## Open questions (for the user)
(auditor fills)
