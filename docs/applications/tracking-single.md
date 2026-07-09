# Tracking (Single)

> **RETIRED 2026-07-08 (commit 6f8097c).** This application was DELETED; its
> role is replaced by [disparity-scope](./disparity-scope.md), and the
> arm-from-drag / KCF discipline now lives in disparity's chained native
> tracker (see the §3.5 tracker-override flow). The module
> `app/modules/tracking-single/` no longer exists. Everything below is kept
> for historical reference only — do NOT treat it as a live app.

**Seed confidence: HIGH → CONFIRMED + refined by audit (2026-07-08).** The
root cause of "no box on drag-end" was NOT any of the seed's three primary
suspects (a–c) but a fourth: the drag-end event never fired `startTracker`
because the handler misread StreamView's `@mouse` stream. Fixed in this lane,
plus two related coordinate-space fixes. Details below.

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
undistorted space and drawn over the undistorted wide view.

## UI & controls
Drag a rectangle on the wide view to arm the tracker (drag-end → `startTracker`
command → session `armAt`); engage/disengage; tracker box size params
(tracker_w/h); wrap toggle for L/R; pred_buffer for the kinematic model.

## Expected behavior
On drag end: tracker arms, an active bbox overlay appears ON THE WIDE VIEW and
follows the target; volts telemetry moves as mirrors track; fovea views stay
centered on the target.

## Audit finding — bug (b): "no box on the wide view after drag-end"

Traced the full path (index.vue drag handlers → `startTracker` → `armAt` →
telemetry `{active,bbox}` → the wide StreamView overlay). Three defects, all
fixed in this lane:

1. **PRIMARY — the drag-end never fired `startTracker` (index.vue `onCursor`).**
   This is the "box never appears" cause. `StreamView`/`FrameView`'s `@mouse`
   stream emits a position on *every* pointer move over the canvas — including
   button-less hover and mouse-UP — and emits `null` only on mouse-LEAVE. The
   migrated handler was a straight port of the old `FrameCursor` logic (which
   *did* null on release): it treated any non-null event as "dragging" and only
   armed on `null`. Result: a normal press-drag-release *inside* the view never
   armed the tracker (and hovering over the view wrongly steered the target);
   the box only appeared if the cursor happened to leave the frame. **Fix:**
   synthesize press/drag/release from the `buttons` bitmask (`c.buttons & 1`),
   exactly like disparity-scope's pointer handler — steer while held, arm on the
   held→released transition. A plain click now also arms (matching the idle hint
   "Click center view to track").

2. **`armAt` armed the native KCF in the WRONG pixel space (session.ts).** The
   native full-frame KCF reads the RAW center stream, so its arm ROI must be in
   raw sensor pixels. The code used `undistort.position([...], /*distort=*/false)`,
   which returns the *undistorted/ideal* pixel — an identity round-trip that
   armed the tracker in undistorted space, grabbing the KCF template offset by
   the local distortion (worse toward the edges). **Fix:** pass `distort=true`
   so undistorted-click → angle → raw pixel (the exact inverse of
   `undistortedCenter`, which maps raw→undistorted for display).

3. **Overlay bbox space was inconsistent (session.ts).** The overlay draws over
   the UNDISTORTED wide view, and the target dot is undistorted, but the
   `onFound` handler published the RAW native bbox straight through (offset by
   distortion), and `armAt` published its ROI box. **Fix:** publish the overlay
   bbox in undistorted display space — `armAt` centers it on the click, `onFound`
   centers it on the undistorted measurement — so the box stays aligned with the
   frame and the predicted-target dot.

Seed suspects revisited: (a) the drag handler *was* the break, but because it
read the wrong event channel, not a stale coordinate space; (b) the telemetry
bbox WAS in raw space over an undistorted overlay (real, fixed as #3); (c) the
overlay binding was intact — `TrackingAnnotations` is fed and rendered, it was
just never given a non-null `active`/`bbox` because #1 blocked arming.

## Verification status
- Type/build gates: vue-tsc 0 errors, vitest 295/295, vite build exit 0.
- RIG-GATED: the native KCF arm-in-raw-space (#2) and the actual on-screen box
  drawing/tracking (#1, #3) require the camera rig. Drive: open tracking-single,
  drag a box on the center (wide) view, release inside the view → the green box
  must appear immediately, sit centered on the target dot, and follow the object;
  hovering (no button) must NOT steer; a plain click must arm.

## Open questions (for the user)
1. **Drag-out-of-frame semantics.** With the button-bitmask fix, if the user
   presses, drags, and releases *outside* the canvas, the `mouse-leave` `null`
   now arms the tracker at the last in-frame point (since `wasDown` was true).
   Is arm-on-leave desirable, or should leaving the frame during a drag *cancel*
   the arm instead? (Current behavior: arms — matches the pre-migration intent
   as closely as the new event stream allows.)
2. **Overlay box shape near frame edges.** The overlay box is drawn axis-aligned
   in undistorted space at the tracker size. The native raw box, once undistorted,
   is really a slight quadrilateral near the edges; we render an axis-aligned box
   centered on the undistorted point. Acceptable, or do you want the true warped
   outline drawn?
