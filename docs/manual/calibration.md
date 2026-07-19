# Calibration Overview

Before the rig can point its mirrors accurately, triangulate a target, or overlay a fovea view onto the wide camera, it has to learn two things: what each camera's lens does to the image, and how the two steerable mirrors map voltages to angles. Calibration teaches it both, and stores the result so every other app (manual control, multi-fovea, the disparity scope, recording) can rely on it. This chapter explains the four calibration apps, the order to run them in, and when to redo each one.

**Prerequisites:** All three cameras connected and assigned their **Left**, **Center**, and **Right** roles in [Manage Cameras](./manage-cameras.md). A printed calibration target — a checkerboard for intrinsic calibration, and ArUco/AprilTag markers on the rig for the mirror-geometry steps. If the rig has a display or projector attached, the calibration apps can project the pattern onto it for you instead of a printed target (see the **Projection** button in [Getting Started](./getting-started.md)).

## The correct order

The four apps build on each other, so run them in this sequence. Each step's data feeds the next — skip one and the later apps either refuse to start or run in a degraded mode.

1. **[Intrinsic](./calibrate-intrinsic.md)** — calibrate each camera's lens on its own. At a minimum the **Center** (wide) camera must be done before anything else, because every mirror-geometry step needs the center lens model to convert pixels to angles. In practice you calibrate all three.
2. **[Extrinsic](./calibrate-extrinsic.md)** — with the center lens known, calibrate the mirror geometry: collect marker poses across the mirrors' range and fit the voltage↔angle regressions for the Left and Right eyes.
3. **[Distortion check](./calibrate-distortion.md)** — a *validation* view (despite its name it changes nothing). It warps each fovea image into the wide camera's frame so you can eyeball how well the previous two steps agree. Use it to confirm before you trust the rig; it saves nothing.
4. **[Drift](./calibrate-drift.md)** — a lightweight touch-up. Once the full calibration exists, this measures the small day-to-day angular offset between where the geometry predicts a marker should be and where it actually appears, and lets you commit a correction without redoing the extrinsic fit.

Steps 2, 3, and 4 all need the full three-camera set present and role-matched at once. If a camera is missing, held by another app, or the geometry data they depend on has not been produced yet, they cannot start — see each chapter for the exact failure the app shows.

## What each step needs, produces, and when to redo it

| Step | Needs | Produces | Redo when |
|---|---|---|---|
| Intrinsic | A connected camera + a printed checkerboard or marker. No prior calibration. | Per-camera lens model (camera matrix + distortion), field of view, and an **RMS** quality number — saved to that camera's configuration. | You swap a camera, change a lens, or an RMS reads poorly. Travels with the camera by serial, so it survives a rig move. |
| Extrinsic | All three cameras connected and role-matched; the **Center** camera already intrinsically calibrated; physical markers on the rig. | Per-eye voltage↔angle regressions for the Left and Right mirrors — saved to the camera set's configuration. | You move or re-seat a mirror, change the camera-set geometry, or the disparity/pointing accuracy has drifted beyond what a Drift touch-up fixes. |
| Distortion check | The full camera set already intrinsically *and* extrinsically calibrated. | Nothing — inspection only. A live warped overlay you read by eye. | Any time you want to verify alignment after Intrinsic/Extrinsic or a rig disturbance. |
| Drift | The full camera set already intrinsically *and* extrinsically calibrated. | A small per-eye angular offset correction — saved to the camera set's configuration. | Daily, or whenever pointing looks slightly off but the geometry is otherwise sound. Faster than redoing Extrinsic. |

## When to redo which step

- **Moved the whole rig, cameras and mirrors together:** intrinsic calibration travels with each camera (it is keyed by serial), so it usually survives. Re-run **Extrinsic** if the camera-to-mirror geometry shifted, then a **Drift** touch-up. Use the **Distortion check** to decide whether Extrinsic is really needed.
- **Swapped or re-lensed a camera:** re-run **Intrinsic** for that camera. If it was the Center camera, you must also re-run **Extrinsic** (and everything downstream depends on it).
- **Re-seated or bumped a mirror:** re-run **Extrinsic**, then a **Drift** touch-up.
- **Daily start-of-session, everything otherwise stable:** just run **Drift**. If pointing is badly off, escalate to the **Distortion check**, and re-run **Extrinsic** if that shows real misalignment.

See also: [Manage Cameras](./manage-cameras.md) for connecting and role-assigning cameras, and [Single Capture](./single-capture.md) for a quick live view of a single camera while you position targets.
