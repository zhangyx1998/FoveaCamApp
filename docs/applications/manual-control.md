# Manual Control

**Seed confidence: HIGH — verified against code 2026-07-08 (auditor). The two
seeded suspicions resolved: the click-steering coordinate space is CORRECT (not a
bug); the capture-timeout surfacing gap is REAL but lives in a shared renderer
file (flagged, not in this app's lane).**

## Purpose
Direct mirror steering + capture/recording: the user steers via clicks on the
center view or via angle set-points (with per-point distance/shift overrides);
views show the undistorted center (optionally zoom-sliced around target), L/R
foveas (optionally aligned/wrapped), and diff/depth composites. Capture runs
multi-point passes (steer→settle→grab); recording writes streams to disk.

## Pipeline (post-real-1g)
Session: triple + `undistort:<C>` advertise + camera pipes + `display` kernel
worker (slice/wrap/diff/depth; C pre-undistorted). Targeting math on main:
`steer` (pixel → `undistort.angular([px], false)`, or angle passthrough) →
`inverseTriangulate` → volts → controller node position input
(`controllerNode().openPosition`, push model; the shared 1 ms actuation loop is
deleted). Capture uses
the composable capture facility (`capture-helper.ts` → the `capture-node` worker)
for one-shot SHM reads (pinned to call-time `latestSeq` so a steer-then-capture
never grabs a pre-steer frame). Recording consumes its own
`leases.L/C/R.camera.stream` (untouched by real-1f/1g). Wide/clickable view binds
`undistort:<serial>` with raw `camera:<serial>` fallback.

Worker frame outputs are `L`, `R`, `center` (session frames). The declared `C`
contract frame is unused by this app — the renderer binds the undistort **pipe**
directly (`usePipeFrame`), not `session.frame("C")`. The worker is NOT run with
`relayCenter`, so it never posts a `C` frame.

## UI & controls
Click/drag steering on the center view; set-point list (angle mode, per-point
d/s overrides); verge/shift/zoom/view mode; capture pass + recording start/stop.

## Expected behavior
Steering is immediate and smooth (push-model fire-and-forget CMD_STREAM updates,
~kHz capable);
sliced view recenters on target; capture passes save the exact post-steer
frames; recording FIN metadata binds voltages to frames.

## Known/suspected issues
- **Click-steering coordinate space — VERIFIED CORRECT (suspicion refuted).**
  The clickable center view binds the `undistort:<serial>` pipe (`frameC`), so
  clicks land in **undistorted** pixel space. `setTargetFromPixel` calls
  `undistort.angular([px], false)`; the `false` flag means "the input is ALREADY
  undistorted — do not undistort it again" (in `Vision.cpp` the flag gates
  `__undistort__(src, src)` before the pinhole `atan((p−c)/f)`). That is exactly
  right for undistorted input. The undistort pipe reproduces `Undistort.apply`,
  whose remap is built with `initUndistortRectifyMap(mtx, dist, {}, mtx, …)` —
  i.e. `newCameraMatrix == mtx`, the same matrix whose `focal()`/`center()` feed
  `angular`/`position`. So the pipe frame and the angular math share one pixel
  space and are exact inverses. `sliceAtParam` (`position([angle], false)`) and
  the overlay (`telemetry.target` drawn on `frameC`) are consistent with the
  same space. On an uncalibrated rig `triple.undistort` is null → `targetAngle`
  stays `{0,0}` (no steering) and `frameC` falls back to raw — degraded but safe.
  RIG-GATED residual: confirm B's native remap producer really uses `mtx` (not an
  `getOptimalNewCameraMatrix` alpha≠0) as its new camera matrix; by spec it
  replicates `apply`, but only a live rig proves the pixel registration.
- **Capture-timeout failure does NOT surface in the UI — CONFIRMED gap (fix is
  out-of-lane).** On a capture-worker one-shot-read timeout (the `capture-node`
  center read), the pass aborts and the `runCapture` RPC rejects (correct, loud,
  server-side). But the renderer
  overlay `app/src/capture/index.vue` does `onMounted(async () => { await
  capture.run(); data_ready.value = true })` with **no `try/catch`** — a
  rejection leaves `data_ready` false forever (overlay stuck "loading") and only
  logs an unhandled rejection to the console. Teardown is safe (`Scope.drain`
  swallows the rejected `waitIdle()`), and a retry works (`busy` was reset in
  `finally`), so the only defect is the silent hang. Fix belongs in the shared
  overlay (`app/src/capture/index.vue`) — see Flagged items in the audit report.
- **Capture preview drops image-only resources — FLAGGED (shared overlay).** The
  overlay's `entries()` yields only resources whose `capture_meta` is non-empty;
  `center` and `diff` are captured image-only (no meta) so they never appear in
  the preview grid, even though `capture.ts` publishes their `capture:<name>`
  frames. Likely unintended; fix (if wanted) is in `app/src/capture/index.vue`.
- **Depth/diff registration under motion — VERIFIED OK.** The display kernel
  caches `aligned.{L,R}` (perspective-wrapped foveae) per frame and rebuilds them
  each frame from the latest `homographyL/R`; those homographies are re-pushed on
  the throttled volt cadence (`VOLT_TELEMETRY_INTERVAL_MS`), so diff/depth stay
  registered up to one throttle interval of lag. `aligned` is always populated
  from the same frame `combined()` consumes, and `combined()` guards on both L
  and R being present.

## Open questions (for the user)
1. **Capture-failure UX.** When the center pipe read times out, should the pass
   (a) fail hard and show an error banner in the overlay (needs the shared
   `app/src/capture/index.vue` to `catch` and render an error state), or
   (b) degrade — skip only the `center` resource, still capture
   `left/right/diff`, and mark `center` as failed in its meta — so the user gets
   a partial result instead of a hang? Current code does neither cleanly (it
   throws and the overlay hangs).
2. **center/diff previews.** Should image-only capture resources (`center`,
   `diff`) show in the overlay preview? They currently don't (meta-filter). If
   yes, either the overlay should stop filtering on meta, or `capture.ts` should
   attach a minimal meta stub to those resources.
</content>
</invoke>
