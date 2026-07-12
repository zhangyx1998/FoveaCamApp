# Disparity Scope

Disparity Scope is the closed-loop vergence bench. You lock onto a target in the
wide (center) view; the app extracts a template around it, matches it against the
left and right fovea streams, and drives the mirror vergence with a PID so both
foveas converge onto the same point at the right depth. This is where you tune
that control loop, watch how well the two eyes agree, and inspect the raw
template-match evidence in a dedicated debugger window.

**Prerequisites:** a full calibration present (see
[Calibration](./calibration.md)) and all three cameras connected (see
[Manage Cameras](./manage-cameras.md)). On an uncalibrated rig the wide view
falls back to the raw image and the overlays will not register.

## The layout

Three live columns across the top:

- **Left Fovea** (cyan) and **Right Fovea** (greenyellow) — the fovea views,
  each with a voltage bar showing its mirror's commanded position.
- **Center** (orange) — two stacked views plus a status line. The upper view is
  the selectable center composite (its title is the view selector). The lower
  view is the clickable wide view carrying the overlays and the status readout,
  with a **Debugger** button beneath it.

A pull-up **drawer** along the bottom holds the tuning columns. Live views expand
into projection windows via their expand button, and `Ctrl-Shift-I` toggles the
diagnostics overlay.

### The overlays on the wide view

The lower Center view shows, in undistorted wide pixels:

- the **target dot** (orange) at the current lock point;
- two **fovea footprint rectangles** (cyan / greenyellow) — where each eye's
  fovea currently projects onto the wide frame;
- the **tracker bounding box** (green) when the tracker is following content.

The status line under it reads out **Vergence** in degrees, **Depth** in metres
(or `∞` when parallel), and the current **status** word. An **override** badge
appears while a drag is pinning the target (see below).

## The center-view selector

The upper Center view's title is a selector with four options; only the selected
view is computed, so switching parks the others.

- **Wide Angle Sliced** — a magnified crop around the target.
- **Disparity (Left v.s. Right)** — the left-vs-right difference image.
- **Anaglyph (Red = Left, Cyan = Right)** — the two eyes overlaid in colored 3D. The label names the colors for the current **Anaglyph style** (set in **Settings → Application**; the default is red = left, cyan = right) and the view follows a change live.
- **SGBM Disparity** — a colored depth heatmap from block matching.

## Steering by dragging (tracker override)

Dragging on the lower wide view takes manual control of the vergence loop:

1. Press on the wide view. On pointer-down the loop **resets** its pan, vertical,
   and verge corrections.
2. Drag. Both eyes track the raw cursor ray **in parallel** — vergence goes to
   infinity and the PID does not step, so the foveas follow your pointer
   regardless of match quality. The **override** badge is lit and the status
   reads manual.
3. Release. The tracker re-arms at that point and the PID resumes smoothly from
   the parallel pose, then re-converges every axis from scratch.

This is deliberate: the earlier "keep the PID running during the drag" behavior
could never chase a drag onto new content, because the match score collapses and
the loop holds. Parallel follow lets you point the rig anywhere first, then let
it converge.

## The tracker

In the **Tracker** column of the drawer:

- The **on** / **off** toggle arms the wide-view auto-follow tracker.
- **Tracker** selects the engine, switchable **on the fly** (the two nodes are
  drop-in replacements running on their own native threads):
  - **Hybrid (NCC + re-detect)** — the default: a normalized-cross-correlation
    template match with a re-detect stage, so a momentarily lost target can
    **recover** rather than staying dropped.
  - **KCF (GRAY)** — the classic kernelized correlation filter.
  Switching mid-tracking re-arms the new engine at the current target and
  keeps steering; if the requested engine is unavailable the selector snaps
  back to the one actually running. A switch requested mid-drag applies when
  the drag ends.
- **Kernel** sets the template width × height (applied on the next re-arm).
- **Status** reads **tracking** (locked), **armed** (enabled, not yet locked),
  **lost** (the toggle is on but ~10 consecutive misses released the
  auto-follow gate — re-enable or drag to re-arm), or **off**. While the
  tracker is **armed or tracking** the vergence **convergence timeout never
  fires** — tracking counts as activity, including the armed-but-hunting
  phase. After a **lost** latch the timeout resumes (from that moment, not a
  stale window).

When armed, the tracker follows the target and steers the match crop, recovering
its lock if the content briefly drops out; a drag overrides it as described
above.

## Tuning the control loop

The drawer's columns, left to right:

- **Parameters** — **Sensitivity** (loop step per elapsed time), **Template
  Scale** (match detail; on a calibrated rig the true match scale comes from
  calibration and this reads out the measured magnification), **Min Match Score**
  (the confidence below which a correction is not trusted), **Timeout** (the
  convergence window in ms; hard left reads **disabled** and turns auto-vergence
  off entirely — manual control only; hard right is `∞`, never times out), and
  **X / Y Expansion** (the guide-strip size around the target). **Display**
  holds the **Zoom Ratio**, which sizes the sliced-view crop. Each column's
  **reset** restores its defaults.
- **Pan PID**, **Depth PID**, **Vertical PID** — the Kp / Ki / Kd gains for each
  degree of freedom, each with its own **reset**.
- **Vergence Angles** — two-way sliders for **Verge**, **Pan X**, **Pan Y**, and
  **V-Shift**: they read out the live loop state, and dragging one takes over —
  auto-vergence disengages immediately (even mid-track; the tracker toggle
  turns off) and the mirrors follow the dragged value. The sliders shift to the
  accent color while manual control holds the loop, and Status reads **held**
  (or **auto off** when the Timeout slider sits at **disabled** — moving that
  slider right does not clear a slider-write hold). A new pointer drag on the
  view or re-enabling the tracker hands control back. The **PID Debug** panel
  reads out live Status, Pan X / Y, Verge, commanded Distance, V-Shift, and the
  actuation round-trip in ms. **reset** zeroes the loop state — under auto the
  eyes re-converge fresh; under a manual hold it recenters the eyes.

If corrections stop applying, check **Min Match Score** against the live match
quality: when the score drops below it the loop holds rather than trusting a bad
match. A steady scene should hold steady Vergence and Depth numbers.

### Auto-tuning the gains

The **Auto-Tune** group (in the Tracker column) can derive the PID gains
experimentally instead of hand-tuning the nine sliders. These are **real
experiments on the rig** — the mirrors move — so the buttons only enable with a
calibrated triple, the tracker **off**, and no drag in flight; run them on a
static, well-matched target (for the depth gains, converge on a **near**
target first — a parallel/infinity pose gives the depth axis nothing to push
against). *This feature is code-complete but not yet verified on hardware.*

- **tune** — the relay stage: each axis in turn is wiggled with a small square
  wave (2–10 % of its range, hard-bounded) until a steady oscillation appears,
  and conservative Tyreus–Luyben gains are computed from it. Seconds per axis.
  An axis that will not oscillate keeps its previous gains (the status line
  names it).
- **tune + polish** — relay first, then a joint optimization (CMA-ES): the
  target is stepped sideways repeatedly and each candidate gain set is scored
  on tracking error, overshoot, and actuation effort. Budget-capped; takes
  minutes.
- **abort** (shown while running) — stops the experiment and restores the
  pre-tune gains and pose. Any takeover (dragging the view, moving a Vergence
  Angles slider, re-enabling the tracker, editing a gain) also aborts — except
  that editing a gain keeps **your** edited value rather than restoring the
  pre-tune gains (only the pose is restored).

The status line tracks progress (axis and cycles during relay, evaluations and
best cost during polish). On completion the new gains land in the PID columns,
and the loop stays **held** at the pre-tune pose — drag on the view or re-enable
the tracker to resume closed-loop control with the new gains.

> **Delay compensation.** A per-triple **Delay compensation** value (set in
> [Settings → Device config](./settings.md#per-triple-settings)) chains a motion
> predictor after the tracker so the mirrors act on the target's *estimated*
> position a few milliseconds ahead (positive **leads**, to offset tracking-chain
> latency) or behind (negative **lags**). It is read at session start, so change
> it in Settings and re-enter Disparity Scope to apply it.

## The Debugger sub-window

The **Debugger** button (below the Center view) opens — and closes — the
template-match debugger, a separate window that rides alongside this app and
closes with it. Press it again to toggle it off.

It stacks three column-aligned views, so a feature at one horizontal position in
the top strip shows its match score at the same position in the two heatmaps:

- **Template Match Guide Strip** — the wide guide strip with overlay rectangles
  marking the center template (orange), the left match (cyan), and the right
  match (greenyellow).
- **Left Match (Red = Match, Blue = Mismatch)** — the correlation heatmap of the
  strip against the left fovea needle.
- **Right Match (Red = Match, Blue = Mismatch)** — the same for the right fovea.

Use it to see *why* the loop is or isn't converging: strong, well-aligned red
peaks in both heatmaps mean a confident match; weak or scattered scores explain a
held or drifting vergence.

## Recording and capture

The title-bar record button (or `Cmd/Ctrl-R`) records the raw left/center/right
streams, and the camera icon opens the shared capture preview. See
[Recording and Capture](./recording-and-capture.md).

## Related

- [Manual Control](./manual-control.md) — open-loop direct steering.
- [Tracking - Multi](./multi-fovea.md) — track several targets at once.
