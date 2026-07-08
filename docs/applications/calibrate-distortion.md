# Distortion View (projection calibration)

**Seed confidence: MEDIUM.**

## Purpose
Validate/calibrate the fovea→wide projection: detect markers in the foveas,
compute the projection homography per detection, warp the fovea image into the
wide view's frame, and display the overlay so alignment errors are visible.

## Pipeline (post-real-1f)
Triple session; C raw preview via pipe; L/R marker detection via native
detector.stream; MAIN computes the projection homography per fovea detection
(cheap 4-pt findHomography, off the camera loop); the `distortion` vision-worker
kernel does the heavy `wrapPerspective`, posting raw + proj_L/proj_R frames.

## UI & controls
Wide + projected-fovea overlay views; target/marker selection; (persist?)
— auditor verifies whether this app SAVES anything or is inspection-only.

## Expected behavior
proj_L/R warp foveas into wide-frame coordinates; a well-calibrated rig shows
seamless overlay at the marker plane.

## Known/suspected issues
- Homography is per-DETECTION — verify staleness handling when detection drops
  (frozen warp vs cleared view).

## Open questions (for the user)
(auditor fills)
