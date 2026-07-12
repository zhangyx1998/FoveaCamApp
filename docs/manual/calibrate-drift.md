# Drift Calibration

Over a session the rig can develop a small, steady angular offset — the mirror geometry still fits, but where the calibration predicts a marker should appear and where it actually appears drift a little apart. Drift calibration measures that per-eye offset live and lets you commit a correction, without redoing the full extrinsic fit. It is the fastest calibration to run and the one you reach for at the start of a session or whenever pointing looks slightly off. Run it after the rig is fully calibrated.

**Prerequisites:** All three cameras connected and role-matched as **Left**, **Center**, and **Right**. The full camera set must already be intrinsically *and* extrinsically calibrated — this app builds on the complete calibrated triple and reads/writes the drift correction on it. If it can't acquire the cameras it reports **Cameras unavailable — held by another app or not connected**. If the calibration data itself is missing, the app instead stalls partway through its startup progress — go back and complete [Intrinsic](./calibrate-intrinsic.md) and [Extrinsic](./calibrate-extrinsic.md) first.

## Continuous mode

Unlike extrinsic calibration there is no wizard — the app runs one continuous mode. Three camera previews (**L**, **C**, **R**) show live marker detection with green dots and a **✓ / ✗ Marker ID to Track:** input each. In the background a visual servo continuously aims each mirror at the center-observed marker direction *plus* the currently-saved drift, so you watch the mirrors converge on the corrected target in real time. The rig projects the target markers and a crosshair for you; a drawer at the bottom exposes **Marker Size** and **Center Marker** sizing plus the live **Servo Gain** (the centering servo restarts seamlessly on change — same knob as extrinsic calibration).

Under the Left and Right previews are the live readouts:

- **Derived Drift** — the offset the app currently measures for that eye (what an update would commit).
- **Δ vs Saved** — how far that live measurement sits from the drift already saved.
- A position pad (**PosView**) for the mirror, which you can drag to override the servo.

The center column carries the currently committed values: **Saved Drift (L)** and **Saved Drift (R)**.

### To measure and commit drift

1. Confirm each eye has locked its marker — the input shows **✓** and dots sit on the marker.
2. Let the servo settle. Watch **Derived Drift** stabilize for the eye you care about; it updates several times a second.
3. Compare against **Δ vs Saved** to see whether the new measurement actually differs from what is already stored.
4. Commit with the center buttons: **Update Drift (L)** writes only the Left eye, **Update Drift (R)** only the Right, and **Update Drift (All)** writes both. The saved readouts update to match.

## The drift lock gate

The update buttons are deliberately gated so you cannot commit a meaningless value:

- An update button is **disabled unless its eye currently has a live marker lock.** If the fovea's tracker is not locked, the derived drift reads **N/A** and that eye's button is greyed out — an unlocked eye would otherwise report a bogus value from a mirror parked at origin. Re-acquire the lock (check for **✗** on the marker input) before committing.
- An update button is also **disabled when the live measurement is within measurement noise of what is already saved** — that is, when **Δ vs Saved** is negligibly small. Re-committing a value that hasn't really changed is churn, not signal, so the app blocks it.
- **Update Drift (All)** requires *both* eyes to pass those gates.

So if a button is greyed out, either that eye is not locked (fix the tracking) or the drift hasn't meaningfully changed (nothing to commit — you are already up to date).

The saved correction is written to the camera set's configuration and is picked up automatically by the pointing and multi-fovea apps.

## What can go wrong

- **Derived Drift reads N/A / Update button greyed out:** that eye is not locked on its marker. Check the marker input for **✗**, improve lighting or marker placement, and let the tracker re-acquire.
- **Update button greyed out with a lock present:** the live drift is within noise of the saved value — there is nothing meaningful to commit.
- **Drift keeps growing between sessions:** a small daily touch-up is normal; a large or fast-growing drift suggests the mirror geometry itself has moved — re-run [Extrinsic Calibration](./calibrate-extrinsic.md) and verify with the [Distortion check](./calibrate-distortion.md).
