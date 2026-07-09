# Tracking - Multi

Tracking - Multi lets you place several targets on the wide (center) view at
once and have each one tracked independently. You mark a target, the app locks a
KCF tracker onto it, and a live fovea crop follows it around the wide frame.
Because there are still only two physical mirrors, the rig time-shares them
across your targets — this app is where you set up and monitor a multi-target
session and record it.

**Prerequisites:** a full calibration present (see
[Calibration](./calibration.md)) and all three cameras connected (see
[Manage Cameras](./manage-cameras.md)). On an uncalibrated rig the overview
falls back to the raw wide image and placements land in distorted pixels.

## The layout

- **Center Overview** — the large wide view across the top, where you place and
  steer targets. Every enabled target draws a colored box, a colored center dot,
  and a number on this view.
- **Controls panel** (top right) — session status, the **Pulse** slider, and the
  **Capture** and **Reset** buttons.
- **Target cards** — a row of cards below the overview, one per target slot. Each
  card carries the target's live fovea crop and its telemetry.

Each target has its own color (blue, amber, green, pink, and so on) that is used
for its overview box and number so you can tell them apart at a glance.

Any live view can be expanded into a stand-alone projection window with its
expand button, and `Ctrl-Shift-I` toggles the diagnostics overlay on the views.

## What the wide view means for you

The **Center Overview** is the shared coordinate frame for the whole session.
Every target is placed, tracked, and numbered in wide-frame pixels, and each
fovea's mirror pose is derived from where its target sits in this frame. When you
record, the wide frame's geometry is written into the file (the "global wide
matrix"), so a recording can always map each fovea crop back onto the wide image
it came from. Practically: aim and judge everything against the overview, and
keep your targets inside it.

### To add and place a target

"Adding" a target is really enabling one of the fixed slots.

1. On a target card, tick its **checkbox** to enable it. The card's fovea tile
   comes alive with real pixels, and a KCF tracker arms on the wide view.
2. Select that target with its **radio** button (or click its card) so drags
   apply to it.
3. Drag on the **Center Overview** to place the target. A hollow ring shows the
   draft position while you drag; release to place it. The tracker then locks
   onto that point and its colored box follows the content.

To move an existing target, select it and drag again. To remove a target, clear
its **checkbox** — that stops its track and blanks its fovea tile without
disturbing the others. **Reset** clears all targets at once.

Four slots are shown. Enabling more targets means ticking more checkboxes, not
creating new cards.

## Reading a target card

Each card shows:

- **Target N** with its select radio and enable checkbox, and **stream <id>**
  (the mirror-scheduling stream, or `-` when none).
- The live **Fovea** crop (amber outline) and a voltage bar for the left mirror
  pose.
- A footer with **lost <count>** (how many frames the tracker has failed in a
  row), the stream rate in **Hz**, and the age of the last synced frame in
  **ms**.

If a target's box disappears and its **lost** count climbs, the tracker has lost
the content — drag on the overview to re-place it.

## Session status

The status chips in the controls panel light up when their condition holds:

- **ready** — the calibrated triple is leased and the app is live.
- **v2** — the connected hardware supports the synchronized multi-target frame
  scheduler.
- The third chip shows the current capture-reject reason.

The **Pulse** slider sets the capture exposure pulse width.

## Capturing and recording

- **Capture** requests one synchronized multi-target grab. On the current
  hardware this is gated: it is refused and the reason is shown in the status
  chip (no images are produced). Synchronized capture becomes available with v2
  hardware.
- The title-bar record button (or `Cmd/Ctrl-R`) records the session's raw
  streams. See [Recording and Capture](./recording-and-capture.md).

## Related

- [Manual Control](./manual-control.md) — single-target direct steering.
- [Disparity Scope](./disparity-scope.md) — closed-loop vergence on one target.
