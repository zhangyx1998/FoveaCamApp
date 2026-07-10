# Manual Control

Manual Control is the hands-on steering bench. You aim the two fovea mirrors
directly — by dragging on the wide (center) view or by stepping through a saved
list of angle set-points — and watch the left and right foveas land on your
target in real time. Use it to line the rig up on a scene, to sweep a grid of
poses, and to grab full-bit-depth captures or record raw streams to disk. There
is no automatic tracker here: the mirrors go exactly where you point them and
stay there.

**Prerequisites:** a full calibration present (see [Calibration](./calibration.md))
and all three cameras connected (see [Manage Cameras](./manage-cameras.md)).
On an uncalibrated rig the views still show live frames but steering is disabled
(clicks do nothing) and the center view falls back to the raw, distorted image.

## The layout

Three live columns sit across the top:

- **Left Fovea** (cyan) — the left fovea view, with a voltage bar beneath it
  showing the mirror's commanded position. A faint trace on the bar previews
  where each saved set-point would drive this mirror.
- **Center Wide** (orange) — two stacked views. The upper one is the derived
  center composite, titled **Center Wide (sliced)** / **(diff)** / **(depth)**
  after the current view mode. The lower one is the clickable wide view you
  steer on; it carries the target overlay (a dot at the current target, with a
  small angle readout). Below the two views are the **Zoom** field and the
  **View** selector.
- **Right Fovea** (greenyellow) — the right fovea view and its voltage bar, the
  mirror image of the left column.

A pull-up **drawer** along the bottom edge holds the set-points editor and the
parameter sliders. Drag its handle up to open it; the camera row shrinks to make
room so nothing is hidden behind it.

Any live view can be expanded into a stand-alone projection window using its
expand button, and `Ctrl-Shift-I` toggles a diagnostics overlay (frame rate,
latency, sequence numbers) on every view at once.

### To steer the foveas by dragging

1. Press and drag anywhere on the lower **Center Wide** view.
2. Both foveas follow the cursor continuously — the target dot tracks your
   pointer and the mirrors are aimed at that point as you move.
3. Release to leave the mirrors parked at the last position. The target stays
   put until you drag again or pick a set-point.

The depth the eyes converge to is set by the **Verge Distance** slider, not by
the drag — dragging only chooses the direction. Steering is open-loop and
immediate: there is no match gate or tracker to lose, so the foveas never
"drop" the target.

### To steer one fovea independently (split)

You can aim the left and right foveas at *different* points instead of one
shared target:

1. Press and drag on a **voltage bar** (the L or R `PosView` beneath a fovea).
   The pointer is a crosshair — that bar is directly draggable.
2. That eye's mirror follows the drag in volt space. The other eye keeps its
   current command (it does not move). An **⟂ independent** badge lights under
   the bar you are steering, and the two per-eye footprint boxes on the Center
   Wide view separate — cyan for L, greenyellow for R.
3. You can drag the other bar too; then both eyes are steered independently.

To **reunify** (return both eyes to one shared target), drag anywhere on the
**Center Wide** view, or pick / snap to a set-point — any target command clears
the split. Releasing a voltage-bar drag does *not* reunify; the eye stays where
you left it. The split is session-local: it is never saved, and re-opening
Manual Control starts unified.

This works even on an uncalibrated rig, because the voltage bars steer directly
in volt space. (Without a full calibration the wide-view footprint boxes are
hidden, since projecting a pose onto the wide view needs the center camera's
calibration — the drag itself still moves the mirror.)

### To aim with saved set-points

The left half of the drawer is the set-points list. Each set-point is an angle
(with optional per-point distance and vertical-shift overrides).

1. Open the drawer and use the **set-points editor** to add or edit points, or
   the **set-points list** to pick one.
2. Hover a point to preview it; click to select it. The foveas snap to that
   point's angle, and the voltage bars' preview traces highlight the selected
   point.
3. To go back to free dragging, drag on the center view again — that clears the
   selection and returns to the last drag position.

Selecting a point overrides the drag target; adjusting **Verge Distance** or
**Vertical Shift** clears the selection unless the selected point pins that axis
itself.

## The parameter sliders

The right half of the drawer holds:

- **Verge Distance** — the depth both eyes converge on, shown in metres, or
  `∞` when the slider is at its far end (parallel gaze).
- **Vertical Shift** — a vertical toe adjustment in degrees, shown with a sign.
- **Depth Window** — the near/far clamp for the **Depth** center view, in
  metres (or `∞`).
- **Capture Stack** — how many frames are averaged into each capture shot.
- **Zoom** (field above the drawer) — magnification of the sliced center crop.
- **View** — the center composite content: **Sliced** (a magnified crop around
  the target), **Diff** (the left-vs-right difference of the aligned foveas), or
  **Depth** (a depth heatmap clamped to the Depth Window).

## Telemetry you can read

- The **voltage bars** under the L and R views show each mirror's current
  commanded position inside its travel limits, plus the faint set-point preview
  traces. They are draggable (crosshair cursor) to steer that eye independently
  — see *To steer one fovea independently* above; an **⟂ independent** badge
  under a bar means that eye is split off the shared target.
- The **target dot and angle readout** on the clickable center view show where
  you are steering, in undistorted wide-frame pixels and in degrees. The two
  outlined **footprint boxes** (cyan L, greenyellow R) mark where each fovea is
  actually aimed on the wide view; while unified they sit together on the
  target, and they separate when you steer an eye independently.
- The **Verge Distance** and **Depth Window** sliders read out the live distance
  in metres.

## Capturing and recording

- **Capture** grabs a single stacked, full-bit-depth shot and opens the capture
  preview window. **Raster Capture** steps through every set-point in the list
  (steer → settle → grab), accumulating an indexed set; while it runs the button
  reads **Abort**, and pressing it (or `Escape`) stops the pass. With an empty
  set-points list, **Raster Capture** falls back to a single shot.
- If the capture preview stays on "loading" and never shows images, the shot
  timed out reading a frame; abort and retry.
- The title-bar record button (or `Cmd/Ctrl-R`) writes raw left/center/right
  streams to disk. See [Recording and Capture](./recording-and-capture.md)
  for both.

## Remote (projector) display

The **Remote Display** selector drives an external projector canvas for
calibration targets: **No Content**, **L + R** (a stereo frame guide in the L/C/R
role colors), or **Checker** (a checkerboard; the **Checker** and **Checker
Size** sliders set the corner count and square size in millimetres).

## Related

- [Disparity Scope](./disparity-scope.md) — closed-loop auto-vergence with a
  tracker and PID tuning.
- [Tracking - Multi](./multi-fovea.md) — track several targets at once.
