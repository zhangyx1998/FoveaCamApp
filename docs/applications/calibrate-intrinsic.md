# Intrinsic Calibration

**Seed confidence: MEDIUM-HIGH. Auditor: confirmed accurate; seq-match
suspicion resolved as CORRECT.**

## Purpose
Per-camera intrinsic calibration (camera matrix + distortion coefficients) →
persisted `CameraCalibration` JSON keyed by camera key (`getCameraKey`, i.e.
vendor/model/serial) under the `calibrate-intrinsic` store path — the input
every undistort/triangulation path consumes (`loadIntrinsic`).

## Pipeline (post-real-1c)
Single-camera session (`activeSerial`) that, like manage-cameras, enumerates all
connected cameras (`refresh` → `listCameraInfo`) and leases only the one
selected. Raw preview rides the `camera:<serial>` pipe (`usePipeFrame`).

Two detection modes (`state.method`):
- **CHECKER** — the `checker` vision-worker kernel (`vision.ts`) runs off the JS
  event loop: reads the pipe frame, `cvtColor(BGRA2GRAY)`, `findChessboardCorners`.
  When corners are found it returns them AND the gray Mat **atomically in one
  `KernelOutput`** (`{ values.points, frames:[{name:"gray",mat}] }`). The session
  (`onCheckerResult`) stores the matched pair in `latestChecker = { gray, img_points }`.
  Worker lifecycle: spawned in `startCheckerWorker` on CHECKER select, terminated
  (`stopCheckerWorker`) on deselect/mode/param switch via `restartDetection`.
- **MARKER** — aruco/AprilTag via the native `detector.stream` on the lease's raw
  stream (already off-loop), scaled by `1/scale`. `latestMarker` holds the current
  detection result; the loop releases the previous frame as new ones arrive.

At `capture()`: CHECKER pushes `{ gray: latestChecker.gray, samples:[{img_points,
obj_points=checkerObjPoints(pattern)}] }`. MARKER refs the current detection's
frame, extracts an owned `Mono8` gray via `frame.view()` (a COPY — safe to retain
after release), builds per-marker samples (corner + interpolated internal points),
releases both the temporary and the loop's implicit ref, and pushes the record.

Every capture also downscales its gray to a ~160 px-wide `Mono8` thumbnail
(`makeThumb`), published in the `records` telemetry so the records list shows the
image (not an anonymous `#N` chip); records still clear on size/pattern change.

At `calibrateNow()`: flattens all records' samples, runs `cornerSubPix` per sample
on the retained gray, then `calibrateCamera(size, img_points, obj_points)`, and
persists `{ ...result, date }` — including the solve's `rms` re-projection error
(exposed by the core binding; additive). `rms` is surfaced post-solve
(`telemetry.lastRms`) and per-camera in the picker (`CalibrationView.rms`, via
`loadIntrinsic`). `resetCalibration` clears a camera's stored cal.

## UI & controls
`index.vue`: picker list of connected cameras with vendor/model/serial, role
badge, calibrated-at + FOV (degrees) + RMS readout, and Calibrate(Checker)/
Calibrate(Marker)/Reset buttons per camera. In the active view: raw preview with
green-dot corner/marker overlay (drawn from `telemetry.detection.points`) and a
"Detector @ N Hz" footnote (`telemetry.detectRate`, session-metered ~1×/s);
CHECKER adds pattern W×H inputs + a pattern-size-mm slider that projects a
physical checkerboard via `RemoteCanvasTeleport` (mm is renderer-local — it
scales only the projected board, never the corner-count math); MARKER adds the
dictionary selector + a detector-downscale (`state.scale`) slider. Captured
records show as thumbnail tiles (click a tile to remove it), Capture (disabled
until a detection exists), and Calibrate (disabled until ≥1 record; shows
"Calibrating…" while `busy`).

## Expected behavior
Corners/markers overlay live at usable rate; captures accumulate as chips;
calibrate yields a plausible rms and populates FOV; save persists; downstream
apps pick the new cal on next acquire. Overlay dots align with the RAW preview
(corners are detected in raw grayscale derived from the same BGRA8 pipe frame; no
undistort is applied to this preview — confirmed).

## Known/suspected issues (auditor findings)
- **Seq-match (RESOLVED — correct):** the seed asked whether capture uses the
  SAME frame the corners came from. It does. The checker kernel derives `corners`
  and `gray` from the same `process(frame)` call and returns them together in one
  `KernelOutput`; the session stores them together in `latestChecker` and capture
  reads the pair. There is no code path that can pair a `gray` frame with corners
  from a different sequence. MARKER mode is even tighter — corners and gray both
  come from the one held detection's frame.
- **Overlay space (RESOLVED — correct):** the overlay rides raw-space detection
  points over the raw `camera:<serial>` pipe preview; no undistort crept in.
- **MARKER capture frame lifetime (RESOLVED — safe):** `frame.view("Mono8")`
  returns a JS-owned TypedArray copy (via `convert<cv::Mat>`), so retaining
  `gray` after the immediate `frame.release()` is safe (not a use-after-release,
  despite the general frame-release-timing rule — `view` snapshots the data).

## Open questions (for the user)
- CHECKER `onCheckerResult`: if a result ever arrived with `v.points` set but no
  `"gray"` frame in `r.frames`, the old `latestChecker` would be kept and could
  be captured as a slightly stale pair. The kernel never does this today (gray is
  always bundled when points are non-empty), so it's only a latent invariant —
  worth a defensive guard if the kernel contract loosens. Not fixed (no current
  trigger).
