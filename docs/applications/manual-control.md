# Manual Control

**Seed confidence: HIGH.**

## Purpose
Direct mirror steering + capture/recording: the user steers via clicks on the
center view or via angle set-points (with per-point distance/shift overrides);
views show the undistorted center (optionally zoom-sliced around target), L/R
foveas (optionally aligned/wrapped), and diff/depth composites. Capture runs
multi-point passes (steer→settle→grab); recording writes streams to disk.

## Pipeline (post-real-1g)
Session: triple + `undistort:<C>` advertise + camera pipes + `display` kernel
worker (slice/wrap/diff/depth; C pre-undistorted). Targeting math on main:
`steer` (pixel → undistort.angular, or angle passthrough) → inverseTriangulate
→ volts → shared actuation loop. Capture uses `readNextPipeFrame` one-shot SHM
reads (pinned to call-time latestSeq so a steer-then-capture never grabs a
pre-steer frame). Recording consumes its own camera.stream (untouched by
real-1f/1g). Wide view binds `undistort:<serial>` w/ fallback.

## UI & controls
Click/drag steering on the center view; set-point list (angle mode, per-point
d/s overrides); verge/shift/zoom/view mode; capture pass + recording start/stop.

## Expected behavior
Steering is immediate and smooth (post fire-and-forget actuation, ~kHz capable);
sliced view recenters on target; capture passes save the exact post-steer
frames; recording FIN metadata binds voltages to frames.

## Known/suspected issues
- Click steering coordinate space: clicks land on the UNDISTORTED pipe frame
  now — verify `setTargetFromPixel`'s `undistort.angular([px])` expects
  undistorted or raw pixel input (a raw-expected mapping fed undistorted pixels
  = subtle steering offset).
- Capture timeout (2s) failure surfacing in UI — does a failed pass show?
- Depth/diff views depend on aligned L/R (worker `aligned` cache) — verify the
  volt-cadence homography updates keep them registered under motion.

## Open questions (for the user)
(auditor fills)
