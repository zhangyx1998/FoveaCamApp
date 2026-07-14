# Split Tracking

Open **Tracking - Split** from the launcher. Two foveas, tracked
independently: you place a target on the left view and one on the right, and
each mirror keeps its own target centered.

## Use it

1. The app leases the L/C/R camera triple and shows the left and right fovea
   views (plus a center context view).
2. Below each fovea view, drag the **target selector** to the feature you want
   that eye to track. When you release, that side's tracker (re)initializes on
   the spot and the mirror starts driving the target to the frame center. The
   box drawn in the view is the tracking tile (its size is labeled); the
   crosshair marks the frame center.
3. Grab a side's selector again to STOP that side (the mirror holds where it
   is); release to re-seed at the new spot. The two sides are independent —
   moving one never disturbs the other.

## Drawer

- **Tracker** — switch the tracking engine (Hybrid / KCF) live.
- **Tile size** — the tracking template size in pixels (512 default). Larger =
  more context, slower; smaller = faster, less robust. Re-arms both sides.
- **Gains (Kp / Ki / Kd)** — the follow servo tuning (bench-set defaults).
- **Status** — per-eye tracking / lost / paused, and any blocking reason
  (e.g. no controller connected).

## Capture & record

The title-bar capture and record buttons work as in the other apps: capture
grabs a full-bit-depth still of the three streams (left fovea / center / right
fovea); record streams them to a `.fovea` file. Capturing and recording are
mutually exclusive.
