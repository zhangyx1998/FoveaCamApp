# Intrinsic Calibration

**Seed confidence: MEDIUM-HIGH.**

## Purpose
Per-camera intrinsic calibration (camera matrix + distortion coefficients) →
persisted CameraCalibration JSON keyed by serial — the input every undistort/
triangulation path consumes.

## Pipeline (post-real-1f)
Single-camera session (`activeSerial`), raw preview via `camera:<serial>` pipe.
Two detection modes: CHECKER — the `checker` vision-worker kernel runs
cvtColor + findChessboardCorners off-loop, posting corners + the gray frame;
at user capture, main runs cornerSubPix + calibrateCamera on the retained
frames. MARKER — aruco via the native `detector.stream` (already off-loop).
Worker lifecycle: spawn on CHECKER select, terminate on deselect/mode switch.

## UI & controls
Mode select (checker/marker), board geometry params, capture-frame button +
captured-set management, calibrate + save, reprojection-error display, preview
w/ corner/marker overlay.

## Expected behavior
Corners overlay live at usable rate; captures accumulate; calibrate yields a
plausible rms; save persists; downstream apps pick the new cal on next acquire.

## Known/suspected issues
- Verify the overlay corners align with the RAW preview (corners are detected
  in raw space — correct; but confirm no undistort crept into this preview).
- Captured-frame retention: the checker kernel posts the gray frame main keeps
  — verify capture uses the SAME frame the corners came from (seq match).

## Open questions (for the user)
(auditor fills)
