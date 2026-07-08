# Distortion View (projection calibration)

**Seed confidence: MEDIUM. Auditor: confirmed; staleness = frozen warp
(documented as an open question, not fixed).**

## Purpose
Despite the module name this is NOT lens-distortion calibration. It is a
projector-alignment / fovea→wide **homography validation** tool: detect the same
marker in each fovea and in the wide (center) camera, compute the projection
homography that maps each fovea image into the wide-frame coordinates, warp the
fovea image through it, and display the overlay so alignment errors are visible.
**Inspection-only — it persists NOTHING** (no store writes; `idle()` just resets
telemetry).

## Pipeline (post-real-1f / C-22b step 3)
Resource-scoped triple session via `acquireTriple` (needs existing calibration:
`undistort` + `conv`). Three `MarkerTracker`s (L/R with `internal` subpixel;
C plain) on native streams. The center tracker's observed angle
(`centerAngle = undistort.angular(C.centerAbsolute)`) continuously drives a
`startActuationLoop` that points BOTH mirrors there (`conv.A2V.L/R(centerAngle)`);
when the center marker is lost, `centerAngle` is null and the loop targets
ORIGIN (mirrors rest at 0,0).

The per-fovea warp is split off the JS loop:
- **Main** (`computeProjection`, on each fovea/center detection tick): builds the
  destination corners from `centerAngle` + the fovea's marker footprint, runs a
  cheap 4-point `findHomography`, ships the flat 3×3 as a param
  (`worker.sendParams({homographyL/R})`), and publishes `projection.{L,R}` (H +
  target points) to telemetry. Guarded by a per-role `projBusy` latch.
- **Worker** (`distortion` kernel, `vision.ts`): reads the L/R fovea pipes and,
  for each role that has a homography, runs the heavy `wrapPerspective`, posting
  the raw preview (`L`/`R`) + the warped overlay (`proj_L`/`proj_R`). The center
  preview rides its own `camera:<serial>` pipe directly.

The registry `onView` tap is gone; raw C rides `usePipeFrame`, and L/R/proj_L/
proj_R ride `session.frame` from the worker.

## UI & controls
`index.vue`: three columns. L/R each show the raw fovea preview (with detection
overlay + `MarkerTargetInputs`), the "Homography Projection" warped preview (with
the target-points overlay), and the live 3×3 `Matrix`. Center shows the raw wide
preview + marker inputs + marker-size/zoom inputs. Controller `pos` is shown in
the L/R stream titles. `RemoteCanvasTeleport` draws the physical markers. Only
command is `setTargetId`. There is NO save/persist control — the app SAVES
nothing (answers the seed's "(persist?)": inspection-only).

## Expected behavior
`proj_L`/`proj_R` warp each fovea into wide-frame coordinates; a well-calibrated
rig shows a seamless overlay at the marker plane. Mirrors follow the wide marker.

## Known/suspected issues (auditor findings)
- **Homography staleness = FROZEN warp (AMBIGUOUS — documented, not fixed):** the
  seed's suspicion is confirmed as "frozen." The worker kernel keeps
  `p.homographyL/R` as persistent state; when a fovea detection drops,
  `computeProjection` early-returns (`!target`) and never clears the homography.
  So the worker keeps warping each *fresh* fovea frame through the LAST computed
  H, and `telemetry.projection.{L,R}` (H + SVG points) also freeze at their last
  value. The warped overlay therefore keeps updating (live raw frame × stale H)
  rather than freezing the whole image or clearing to blank — which can display a
  misaligned warp that looks like a calibration error when it is really just a
  dropped detection. Whether "keep last" (current) or "clear on drop" is desired
  is a UX judgement, so it is intentionally NOT changed (see Open questions).
- Center-marker loss correctly parks the mirrors at ORIGIN (via the null-angle
  fallback) — intended.

## Open questions (for the user)
- On a dropped fovea detection, should the projection be (a) frozen at last H
  (current behavior), (b) cleared so `proj_L/R` blank out and the Matrix/points
  hide, or (c) visually flagged as stale (e.g. dim/label the warp)? A clear/flag
  option would need main to `sendParams({homographyL: null})` on the tracker's
  loss event and null `projection[role]` — mechanically simple, but the desired
  UX is unclear, so left for you to decide.
