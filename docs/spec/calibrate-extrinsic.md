# Calibrate-extrinsic — developer behavior spec

Developer-facing behavior spec for the `calibrate-extrinsic` app: a 3-step wizard that
builds the per-fovea extrinsic dataset `loadExtrinsic`/`leaseCalibratedTriple` consume.
Code carries tight one-line pointers here.

## Wizard state machine {#wizard}

Three steps, `state.step` switching the actuation mode (`enterStep`, called at activation
and on every `step` change — `s.setState` does NOT fire `watch` for server-initiated
changes, so command handlers that change `step` also call it directly):

- **CAL** (capture): `startServo` — tracker-driven visual servo with manual override via
  drag. A fresh servo's per-eye override slots start released, mirrored into contract
  state so a stale engaged echo can't survive a step round-trip.
- **FIN** (review/regression-fit): no actuation (static review). `finalize` fits both
  eyes' regressions (`fitExtrinsicRegression` over `createDataSet`).
- **PRV** (interactive test): a paced position input pushes the drag-computed
  `previewVolt` to the controller node — testing the just-fitted regressions (no volt
  mirroring). `setStep("PRV")` is gated on both regressions being fitted.

This tool deliberately does NOT use `leaseCalibratedTriple()` — that requires EXISTING
extrinsic data, which is exactly what this tool produces. It uses role-matched cameras
(`matchTriple`) + the center camera's intrinsic calibration only (`loadIntrinsic`).

## Capture measurements {#capture-measurements}

Each CAL capture records, per record: the L/R foveae's marker img/obj points + mirror
voltage, and the center camera's marker + observed wide angle. Plus the ruled measured-
magnification inputs off the center record:

- **Ruling 3** (`side_pts`, preferred): the WIDE camera's raw view of the SIDE markers
  (the SAME physical markers the L/R foveae track) — matched from `C.otherTargets` by the
  per-eye target id, recording its outer 4-corner quad. Absent when the wide camera didn't
  see that side marker → that eye's record falls back to the center marker.
- **Ruling 2** (fallback): the wide camera's own center-marker quad.
- The independently-adjustable marker sizes (`side_mm`, `center_mm = side_mm × ratio`)
  read from the app config at capture.

`dataset.ts` reshapes records into the per-fovea `ExtrinsicDataset` — all
measured-magnification fields are optional so a record captured before they existed (or
where the wide camera couldn't see the side marker) degrades to "no measured
magnification" for that record.

The PRV preview maps angle → volt via `A2V.predict` (NOT the reverse — the original
renderer's preview.vue had this backwards; fixed here), then round-trips each predicted
volt back through V2A → angle → pixel for the wide-view overlay.

## Persistence {#persistence}

CAL records live in a scratch doc (`tmp/calibrate-extrinsic`) during the wizard. `confirm`
persists each eye's finalized dataset as a calibration-records-v2 RECORD (content-hash id
over the solve payload) bound to this camera + triple; an identical dataset (same id)
already on disk just gains the association (idempotent). `loadExtrinsic` resolves the
latest record bound to the camera.

## Capture & recording {#capture}

capture-recorder-everywhere. Recording records the raw L/C/R sensor streams (advert-
verbatim). Capture is DEGRADED: this tool holds no undistort (it PRODUCES the extrinsic
data), so the L/R foveae stack raw WITHOUT the fovea homography wrap (stated in
`capture_meta`). EXCLUSIVITY (ruling 6): a recording is refused while a capture shot holds
the shared raw pipes; `busy()` refuses a mid-recording/mid-capture drain.

## Teardown {#teardown}

Resource-scoped (FIFO/LIFO defers). Two-stage acquire (`matchTriple` then center-intrinsic
load) releases IMMEDIATELY on either failure — the lease only becomes scope-owned once both
succeed. A match failure freezes the progress monitor at "Leasing cameras", a missing center
intrinsic at "Loading center intrinsics". The servo/preview toggle per step drains FIRST;
an in-flight recording finalizes before the leases release (LIFO); the lease releases LAST.
