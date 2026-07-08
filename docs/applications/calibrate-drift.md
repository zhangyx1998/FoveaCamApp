# Incremental Calibration (Drift)

**Seed confidence: MEDIUM-LOW — auditor derives the delta vs extrinsic.**

## Purpose
Light-weight recalibration to correct drift without redoing the full extrinsic
procedure — same marker substrate, fewer poses, producing an incremental
correction to the persisted records.

## Pipeline (post-real-1f)
Triple session; raw previews via pipes; native detector.stream; shares the
marker-calibration substrate with calibrate-extrinsic (records/fit helpers).

## UI & controls / Expected behavior
(auditor derives from code — seed intentionally thin)

## Known/suspected issues
- Same settle-info concern as extrinsic (fire-and-forget actuation).

## Open questions (for the user)
(auditor fills)
