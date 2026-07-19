# Calibrate-intrinsic — developer behavior spec

Developer-facing behavior spec for the `calibrate-intrinsic` app: per-camera
intrinsic calibration. Unlike the fixed-triple control-loop sessions, it manages an
arbitrary set of connected cameras (like manage-cameras) and leases only the one
currently selected for live detection. Code carries tight one-line pointers here.

## Detection modes {#detection}

Two calibration-target detectors, restarted on any of `method`/`pattern_size`/
`dictionary`/`scale` (`restartDetection`):

- **CHECKER** runs in the `checker` vision worker (off the JS event loop) on the
  registry's shared RGBA8 preview (converted to grayscale in the kernel). It posts the
  corner points + the gray frame; main retains the gray for `cornerSubPix` /
  `calibrateCamera` at capture time.
- **MARKER** can't use the shared preview: `MarkerDetector` consumes a raw
  `Frame`/`Stream<Frame>`, not a `Mat`. Following the concurrent-raw-stream precedent
  (core's `Sub::Queue` gives each iterator its own bounded backlog), marker detection
  runs its own independent `detector.stream(lease.camera.stream, ...)` consumer alongside
  the registry's preview loop on the same camera.

### Frame lifetime (load-bearing) {#frame-lifetime}

The MARKER path holds native `Frame`s and MUST release them precisely (see the frame
release invariant — extract data before `release()`, never after):

- `stopMarkerTask` releases the held detection's frame — the detection loop never
  releases the current one once it stops, so it must be freed here or the native buffer leaks.
- In the loop, the previous detection's frame is released once a newer result arrives
  (mirrors the original's `watch(detection, (_,prev) => prev?.frame.release())`).
- `capture()` transfers cleanup responsibility: nulling `latestMarker` means the loop
  never sees this result again, so capture `.ref()`s for its own temporary hold across the
  awaited `view()`, then releases BOTH that temporary hold AND the loop's implicit per-yield
  ref once data is extracted.

The `abortableNext` marker task rejects with `AbortedError` on every `.abort()` (the
cooperative-cancellation contract, not a failure) — swallowed; anything else is reported.

## Records model {#records}

Calibration solves persist as intrinsic RECORDS (calibration-records-v2): a content-hash
id over the solve payload, bound to the camera via an association. An identical solve
already on disk just gains the association (idempotent). `resetCalibration` drops THIS
camera's association from every intrinsic record; a record left with no associations is
orphaned and hard-cleared (an explicit destructive reset, not the refcount trash path);
records shared with other cameras keep their remaining bindings. It also clears any
un-migrated legacy per-camera doc.

## Capture & recording {#capture}

The DEGENERATE single-stream case of capture-recorder-everywhere. Recording records the
selected camera's raw full-depth sensor stream (advert-verbatim). Capture burst-stacks
that raw sensor into ONE held resource (no wrap/center/diff), REUSING the session's
`select` lease (it never acquires its own camera). Both are built per `select` (the lease
is per-camera, unlike the fixed-triple sessions) and stopped on `deselect`. EXCLUSIVITY:
a capture shot is refused while a recording is active (shared raw pipe ids),
and vice versa; `busy()` refuses a mid-recording/mid-capture drain. Deselect finalizes
an in-flight recording + capture shot BEFORE the lease releases (their raw pipes must
release while the camera is still leased).
