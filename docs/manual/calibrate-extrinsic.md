# Extrinsic Calibration

Extrinsic calibration teaches the rig how each steerable mirror's drive voltage maps to a viewing angle. You place markers in the scene, let the mirrors track them across a range of poses, capture each pose as a data point, and the app fits a per-eye regression that converts between voltage and angle in both directions. This is the geometry that lets manual control and multi-fovea point the mirrors accurately, and that the disparity scope depends on. Run it after intrinsic calibration and before the distortion check and drift.

**Prerequisites:** All three cameras connected and role-matched as **Left**, **Center**, and **Right** (see [Manage Cameras](./manage-cameras.md)). The **Center** (wide) camera must already be intrinsically calibrated ([Intrinsic Calibration](./calibrate-intrinsic.md)) — the app uses the center lens model to turn marker pixels into angles, and cannot function without it. Physical ArUco/AprilTag markers placed on the rig. The Left and Right cameras do **not** need intrinsic calibration for this step, and no prior extrinsic data is required — this app produces it.

## The three-step wizard

The app is a three-step wizard: **CAL** (collect poses), **FIN** (review and fit), and **PRV** (test the fit). The current step is reflected in the address, so a restart returns you to the same screen. You move forward with the **Finalize**, **Preview Results**, and **Confirm and Save** buttons, and back with the on-screen back links.

### Step 1 — CAL: collect marker poses

The CAL screen shows all three camera previews side by side (**L**, **C**, **R**), each with green marker-detection dots overlaid. Below each preview a marker input reads **✓ Marker ID to Track:** (or **✗** when that camera currently sees nothing) with the marker ID to lock onto. The rig projects the physical target markers and a crosshair for you.

While CAL is active, a continuous visual servo keeps both mirrors pointed at their tracked markers, so the previews stay locked on as you move the target. Under each of the Left and Right previews is a position pad (**PosView**) showing that mirror's current drive voltage, with a trail of the voltages you have already recorded.

1. Confirm each camera has locked its marker — the input shows **✓** and dots sit on the marker.
2. If you need to nudge a mirror off the servo's choice, drag on that eye's position pad to pin the mirror at the dragged pose; release to hand control back to the servo.
3. When all three cameras are locked on a good pose, click **Capture**. It stays disabled (**Capture**) until the controller is connected and all three cameras report a detection.
4. Each capture is added to the records list in the center column, labelled with an index and the center camera's measured angle, for example `[03] X 1.20°, Y -0.45°`.
5. Move the target (and let the mirrors re-track, or drag them) to a new pose and capture again. Spread the poses across the mirrors' working range — the wider the spread, the better the fit.
6. To drop a record, click the trash icon on its row. **Clear** removes all records and is disabled when the list is empty.
7. Adjust marker sizing if needed in the drawer at the bottom: **Marker Size** (mm) and **Center Marker** (its size as a percentage of the others). You may set these freely — the side and center marker sizes are recorded with every capture, so shrinking the center while growing the sides is fine.

> **Tip — measured fovea↔wide zoom.** Each capture also measures the fovea↔wide magnification the [Disparity Scope](./disparity-scope.md)'s "Auto" zoom uses. It is taken from the **wide (Center) camera's view of the side markers** — the same physical markers the Left/Right foveae track — so captures where the Center camera can also see both side markers give the best measurement. When the Center camera can't see a side marker, the app falls back to its view of the center marker (which is why the recorded marker sizes matter). Calibrations captured before this feature simply carry no measured zoom, and the scope's Auto mode falls back to 1× until you set a zoom manually.

When you have a good spread of poses, click **Finalize**. This fits both the Left and Right regressions and advances to the FIN step. **Finalize** is disabled until you have at least one record.

### Step 2 — FIN: review the fit

FIN is a static review — no mirror motion. For each captured record it draws the marker outline as seen by each of the three cameras (Left, Center, Right) as a vector overlay, so you can scan the set for a bad or misdetected pose. There are no live images here, only the recorded shapes.

From the back link at the bottom you can:

- **Back to Calibration** — return to CAL to capture more poses or remove bad ones.
- **Preview Results** — advance to the PRV test step. This is disabled until the regressions have fit successfully.
- **Confirm and Save** — write the fitted calibration to the camera set's configuration.

### Step 3 — PRV: test the fitted regressions

PRV lets you check the fit before committing. It drives both mirrors from a target you set by dragging on the **Center** preview: the app predicts each eye's voltage for that angle, actuates the mirrors, and overlays where it expects the Left and Right views to land (colored cursors on the center image). The Left and Right position pads show the predicted voltages.

1. Drag on the center preview to place a target.
2. Watch the mirrors swing to it and check the overlaid Left/Right cursors land where the marker actually is.
3. Try several targets across the field to confirm the fit holds.
4. When satisfied, click **Confirm and Save** to persist the calibration. Once saved the button reflects the completed write. Use **Back to Summarize** to return to FIN.

## Where the calibration is stored

**Confirm and Save** writes each eye's calibration as a **calibration record** —
a content-addressed snapshot of the datapoints bound to that camera and this rig.
The Left/Right eye each gets its own record. Re-running the calibration with the
exact same datapoints just re-associates the existing record rather than
duplicating it.

You manage these records from **Settings → Device config → Calibration records**:
inspect a record's observed-vs-projected fit in the visualizer, aggregate several
records into one, export/import them as JSON, or discard them (see
[Settings](./settings.md#calibration-records)). You can also toggle a record as a
live **overlay** there — with this Extrinsic window open, the record's marks are
drawn straight over the matching Left/Right stream so you can compare a stored
calibration against the live scene.

## What can go wrong

- **Capture is greyed out:** the controller is not connected, or at least one of the three cameras is not currently seeing its marker. Look for a **✗** on any marker input and re-acquire the lock before capturing.
- **Preview Results is greyed out:** the regressions have not fit yet — return to CAL, make sure you have enough well-spread records, and **Finalize** again.
- **Finalize / Clear greyed out:** you have no records captured yet.

Next: verify the result with the [Distortion check](./calibrate-distortion.md), then keep it fresh with [Drift](./calibrate-drift.md).
