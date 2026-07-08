# Tracking (Single)

**Seed confidence: HIGH.**

## Purpose
Single-target closed-loop tracking: the user marks a target on the wide
(undistorted) center view; a native KCF thread tracks it on the raw center
stream; kinematic prediction + actuation steer both mirrors so the foveas stay
on target; wrapped/aligned fovea views + diff/depth composites for inspection.

## Pipeline (post-real-1g)
Session: acquires triple, advertises `undistort:<C serial>` (native
UndistortStream), connects camera pipes, spawns the `display` kernel worker
(fovea wrap via main-shipped homographies, slice/diff/depth; C arrives
pre-undistorted from the pipe). KCF = native `KcfTrackerStream` on the RAW
center stream (`createTracker`), results via async generator →
`undistortedCenter(bbox)` maps raw bbox → undistorted target space → kinematic
model → actuation (CMD_STREAM). Wide view + "C" debug sub-window bind
`undistort:<serial>` (camera fallback). Overlays (bbox/target) are computed in
undistorted space and drawn over the undistorted wide view (post-real-1g fix).

## UI & controls
Drag a rectangle on the wide view to arm the tracker (drag-end → `startTracker`
command → session `armAt`); engage/disengage; tracker box size params
(tracker_w/h); wrap toggle for L/R; pred_buffer for the kinematic model.

## Expected behavior
On drag end: tracker arms, an active bbox overlay appears ON THE WIDE VIEW and
follows the target; volts telemetry moves as mirrors track; fovea views stay
centered on the target.

## Known/suspected issues
- **USER-REPORTED: no box appears on the wide view after user drag-end.**
  Suspects (verify in order): (a) the drag-end handler never issues the arm
  command / uses a stale coordinate space (drag is over the UNDISTORTED pipe
  frame now — is the click→center mapping still assuming the old session-frame
  view?); (b) session telemetry `{active, bbox}` publishes RAW-space bbox while
  the overlay expects undistorted (or vice versa); (c) the overlay component
  binding was lost in the usePipeFrame migration (overlay props no longer fed).
- The arm path round-trips undistorted→angular→raw ROI (`armAt`) — verify the
  clamps against actual frame dims (width/height learned from worker size
  telemetry now, not onView).

## Open questions (for the user)
(auditor fills)
