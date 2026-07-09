# Calibration polish — post-migration fixes + UX

Status: **SHIPPED (code-complete 2026-07-09, `b62abe9`; rig pass owed — `hardware/stage-f.md` §Calibration polish)**. Source:
the planner's calibration-pipeline review against master (migration verified
COMPLETE; ported math faithful; one deliberate master bug fixed — extrinsic
PRV A2V/V2A swap). These are the residual findings + the UX items worth
taking while the files are open.

## Findings (fix wave)

1. **Drift `derived` lost the fovea-lock gate** (MED, regression vs master).
   Master gated each eye's derived drift on `tracker.L/R.target` being live;
   the session's 200 ms timer (`calibrate-drift/session.ts`) derives from
   controller pos + center angle only. The UI enables "Update Drift" off
   `derived` non-null, so a drift can be committed while the fovea tracker
   is NOT locked — a plausible-looking but meaningless value (mirror parked
   at origin). Fix: gate per side on `trackers.L/R.target` in the timer AND
   in `updateDrift` (defense in depth).
2. **Intrinsic checker lost the projected pattern** (rig-blocking migration
   gap). Master's `calibrate-checker.vue` projected the checkerboard via
   `RemoteCanvasTeleport` (+ pattern-size-mm slider); the unified
   `calibrate-intrinsic/index.vue` has neither — checker calibration cannot
   run on the rig. Extrinsic/distortion/drift kept their teleports. Pure
   renderer port from master (pattern math + component both exist); no
   session change.
3. **Marker `scale` is dead state** (LOW). `contract.ts` has `scale: 4` and
   the session restarts detection on change, but the UI renders no control.
   Restore the slider (master had one).

## UX items (same wave, ruled in by "prepare for next iteration on this")

4. **Record thumbnails (intrinsic)**: the session retains a gray `Mat` per
   record but the UI shows anonymous `#N` chips and click-deletes them
   sight-unseen. Publish a small per-record preview (downscaled, via the
   session frame transport or telemetry) so removal is informed.
5. **Calibration quality**: the native `calibrateCamera` binding drops
   OpenCV's RMS reprojection error. Expose it (small core change), persist
   it with the calibration, show it in the picker next to FOV/date; report
   per-solve in telemetry.
6. **Detection-rate footnote**: the vision workers already self-meter
   (`meterName` → perfSnapshot.workloads); surface the detector Hz in the
   `StreamView` footnote (master showed "Detector @ N Hz").
7. **Drift delta readability**: show derived-vs-saved delta; disable update
   buttons below a noise floor (pairs with finding 1's gating).

## Non-items (verified fine)

- Store paths/shapes byte-compatible with master — existing calibrations
  load unchanged. Triple-doc `describeCamera` seeding dropped — nothing
  reads it; not restored.
- Extrinsic regression config (`ply [3,2,1,0]`), distortion projection
  math, drift servo composition (kp 10.0): line-for-line faithful ports.

## Execution

One app-side worker wave (items 1–4, 6, 7) + one small core touch (item 5:
RMS out of `calibrateCamera`, additive). Gates: vue-tsc, vitest, core make +
tests if item 5 lands. Rig re-verification: stage-f gains §"Calibration
polish" (checker projection visible + solve on rig; drift gate behavior).
