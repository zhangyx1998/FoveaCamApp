# Split Tracking

Open **Tracking - Split** from the launcher. Two foveas, tracked
independently: you place a target on the left view and one on the right, and
each mirror keeps its own target centered.

## Use it

1. The app leases the L/C/R camera triple and shows the left and right fovea
   views (plus a center context view). A fixed box is drawn at the center of
   each fovea view — that is where tracking initializes; its size is labeled.
2. Below each fovea view, drag the **voltage pad** to steer that mirror until
   the feature you want to track sits inside the center box. When you release,
   that side's tracker locks onto whatever is in the center box and the mirror
   then follows it, keeping it centered.
3. To re-aim, grab the pad again (this stops that side and hands you manual
   steering), move the target into the center box, and release to re-lock. The
   two sides are independent — steering one never disturbs the other.

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
