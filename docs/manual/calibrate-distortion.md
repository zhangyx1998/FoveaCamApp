# Distortion Check (Projection Validation)

Despite its name, this app does **not** calibrate lens distortion — that is [Intrinsic Calibration](./calibrate-intrinsic.md). This is a *validation* tool. It takes the calibration you already produced, warps each fovea (Left / Right) image into the wide camera's coordinate frame, and overlays the result so you can see by eye how well the two agree. Use it to confirm the rig is well calibrated, or to spot where it is not. It is inspection-only: **it saves nothing and changes no stored calibration.** Run it after [Extrinsic Calibration](./calibrate-extrinsic.md), whenever you want to verify alignment.

**Prerequisites:** All three cameras connected and role-matched as **Left**, **Center**, and **Right**. The full camera set must already be intrinsically *and* extrinsically calibrated — the app builds on the complete calibrated triple and cannot start without it. If it can't acquire the cameras it reports **Cameras unavailable — held by another app or not connected**. If the calibration data itself is missing, the app instead stalls partway through its startup progress — complete [Intrinsic](./calibrate-intrinsic.md) and [Extrinsic](./calibrate-extrinsic.md) first.

## What you see

The screen is three columns, one per camera. While the app runs, a continuous loop reads the marker the **Center** camera is tracking and points *both* mirrors at that same wide-angle direction, so the fovea cameras look where the center is looking. If the center marker is lost, the mirrors park at their origin.

- **Left** and **Right** columns each show two stacked previews: the raw fovea camera view (with green marker-detection dots and a **✓ / ✗ Marker ID to Track:** input), and below it a **Homography Projection** view — that same fovea image warped into the wide frame. Under the warped view is the live 3×3 projection **Matrix**. The mirror's current drive voltage is shown in the raw preview's title.
- **Center** column shows the raw wide preview with its own marker input, plus **Marker Size (mm):** and **Marker Zoom:** number fields that size the markers the app projects onto the rig display.

### To validate alignment

1. Confirm each column has locked its marker (**✓** on the input, dots on the marker).
2. Read the **Homography Projection** panels. On a well-calibrated rig each warped fovea image lines up seamlessly with the wide view at the marker plane — the warped marker sits where the wide camera sees it.
3. Misalignment in the warped overlay points at a calibration problem in the earlier steps. If it looks off, re-run [Extrinsic Calibration](./calibrate-extrinsic.md) and, if needed, re-check the Center camera's [intrinsic](./calibrate-intrinsic.md).
4. Adjust **Marker Size (mm)** and **Marker Zoom** only to make the projected markers detect reliably; they do not affect any stored data.

There is no save control anywhere in this app, by design — everything here is a live read.

## A caveat when a marker drops

If a fovea camera loses its marker, the warped **Homography Projection** for that eye keeps warping fresh frames through the *last* alignment it computed, rather than clearing. The overlay can therefore look misaligned when the real cause is simply a dropped detection, not a calibration error. If a projection suddenly looks wrong, first check that the fovea's marker input still shows **✓** before you conclude the calibration is bad.

Next: keep a good calibration fresh with [Drift](./calibrate-drift.md).
