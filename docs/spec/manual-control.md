# Manual-control — developer behavior spec

Developer-facing behavior spec for the `manual-control` app: a calibrated L/C/R
triple + timer-paced actuation with NO KCF tracker. Distinct from the user manual.
Code carries tight one-line pointers to these anchors.

## Targeting {#targeting}

There is no tracker state machine — the target is ALWAYS whatever `steer` last set:
either a mouse-drag pixel (converted server-side via `undistort.angular`) or a
locally-held set-point's angle (radians the renderer computes from a selected set-point;
pure client-side data, no camera access). Angle mode carries optional per-point
distance/shift overrides. Any `steer` (wide-view drag OR programmatic set) REUNIFIES the
split (one rule, no special cases — both eyes return to the shared solution).

`targetVolts` solves L/R from the single steered angle via `inverseTriangulate → A2V`,
then applies the per-eye split override (override > unified; a null eye keeps the shared
solution). Uncalibrated → origin volts.

## Split fovea {#split}

Session-local, NOT persisted (re-entry starts unified). Normally both eyes share one
target. A drag on the L (or R) voltage `PosView` pins THAT eye to a directly-chosen
volt-space position; the other eye keeps following the unified solution ("holds its
current command" since nothing else moves it). Volt-space, so it works uncalibrated.
Release KEEPS the pin — the eye stays where dragged; only a wide-view drag or a set-point
reunifies (the renderer emits no clear on release). `split.ts` holds only the precedence
rule (`resolveVolts`, `splitFlags`, `isSplit`) so it is unit-testable without a session.

The per-eye wide-view footprint boxes are drawn from the per-eye L_PX/R_PX volt
projections (`A2P.C(V2A(volts))`), so the two boxes physically separate while split.
DEGRADE on uncalibrated rigs — `A2P.C` throws without an undistort (the disparity-scope
hw-1 crash lesson); return {0,0} and let the renderer hide the boxes.

## Drag slew {#drag-slew}

value-sweep 2026-07-11 `manual-control-drag-slew` (`slew.ts`). The 1 ms pacer used to
re-push the RAW latest pointer target every tick; between pointer samples the pose is
IDENTICAL, the StreamUpdateGate/MirrorSink dedupes it, and the serial link idles at the
pointer sample rate despite ~600–1000 Hz of governed capacity. Instead the pacer keeps the
previously COMMANDED pose and slews it toward the latest target with a first-order smoother
(τ = `SLEW_TAU_MS` = 8 ms) — during motion every tick yields a DISTINCT intermediate pose
the gate passes, so the wire runs at capacity with meaningful interpolation (smoother MEMS
motion). Within `SLEW_EPSILON_V` (0.005 V, just above the DAC LSB) it SNAPS to the exact
target once and goes quiet (identical poses dedupe). The first tick (or post-reset) commands
the target directly — never swoops in from a stale origin. NOTE: disparity-scope has a
parallel copy (`drag-slew.ts`) — keep the constant/shape consistent; a later dedup can hoist
both into @lib.

## Display worker & views {#views}

The PROCESSED DISPLAY views (magnified slice, perspective-wrapped foveae, combined
diff/depth) run OFF the JS event loop in the shared `display` vision-worker kernel. Main
computes the calibration-derived matrices and pushes them as worker params on each throttled
volt/target update (cheap; the worker uses the latest):

- `voltParams`: the fovea homographies (`A2H∘V2A(volts)`) + the depth Q-matrix at the
  current pose.
- `sliceAtParam`: the undistorted center pixel the magnified "sliced" view crops around.
- `depthParams`: the depth-heatmap clamp range for the "depth" combined view.

The renderer binds each L/C/R main view to its own `camera/<serial>/undistort` pipe DIRECTLY
(C intrinsic, L/R homography — the mirror-pose-tracked warp the retired `wrap` toggle did in
the kernel), at pipe rate independent of the kernel. Only the derived center composite
(sliced/diff/depth) still rides `session.frame`. The kernel keeps consuming the raw CONVERT
L/R inputs — its diff/depth `aligned` composite wraps them via the pushed H.

## Actuation {#actuation}

Push model (controller-node-and-fifo-edges §3): the SESSION owns the 1 ms pacer cadence.
Each tick slews toward `targetVolts`, pushes the pose, and uses the node's synchronous
predicted-volts return for the local mirror mirror + telemetry. `onApplied` supplies the
awaited round-trip ms on the v1 fallback (~0 on the v2 streaming path). Volt + pose telemetry
is throttled to `VOLT_TELEMETRY_INTERVAL_MS`.

## Capture & recording {#capture}

capture-recorder-everywhere. Capture is the shared `@orchestrator/capture-helper` (the
createCaptureNode wiring + the ON-DEMAND per-shot raw L/R advertise/connect + telemetry + the
recording-vs-capture exclusivity guard were lifted VERBATIM); manual-control is a CONSUMER
supplying its calibrated-triple snapshot (`captureSnapshot`: the calibration-derived transforms
+ per-resource metadata for the whole shot). Full fovea snapshot requires undistort — null
degrades the command to "Capture not ready".

The renderer drives the raster: it owns the set-points + steer, so per-shot `capture({tag})`
replaces the old server-side setpoints sweep. `tag` present ⇒ a raster shot that ACCUMULATES
an indexed resource; `tag === 0`/absent starts a fresh accumulation. Resources are held by the
capture node; images are PULLED per resource via `getPreview`/`getCapturePreview` (ruling 7).

Recording flows entirely through the RECORDER NODE (`@orchestrator/recorder-node`) — one worker
thread FIFO-consuming the full-bit-depth `camera/<serial>/raw` pipes and hosting the mcap writer
in-worker (built on the shared `@orchestrator/recording-service`). Main only advertises the raw
pipes, creates/retires the node, and answers the ruling-3 per-frame metadata callback. Only the
L/R foveae carry a voltage binding (`resolveFoveaBinding`/`buildFoveaMeta`): FIN-bound frames
carry the exposure-averaged voltage + frame_id (`volt.source: fin-averaged`), free-run frames a
live snapshot (`live-snapshot`); both add the mirror angle + homography. The center channel skips
the per-frame notice (R-2 opt). On finalize, main is notified (`recording:finished`) so the viewer
auto-opens the finished `.fovea`.

EXCLUSIVITY (ruling 6): a capture shot in flight holds the raw L/R pipes; starting a recording
would re-advertise the same ids and the shot's release would then retire the recording's
producers — so a recording is refused (false) while `capturing`. Between raster shots `capturing`
is false, so a recording CAN start there; the next capture shot is then refused by the helper's
guard. `busy()` refuses a mid-recording/mid-capture drain.

## Teardown ordering {#teardown}

The trickiest teardown in the fleet: a capture/recording pass may still be reading a stream (or
awaiting a one-shot center-pipe read) when the last subscriber leaves — it MUST fully drain BEFORE
the worker terminates + the pipes disconnect + the leases release. Resource-scope defers are
registered in REVERSE of the drain (LIFO): stop the pacer FIRST (stop pushing) → await the async
capture/recording drain (raw pipes release) → terminate the worker + disconnect pipes → release
the lease LAST. The undistort producer retirers are registered before the worker's defer so they
retire AFTER consumers disconnect. The worker holds its own Undistort independent of main's
`triple`, so it keeps posting for a capture waiting on the next processed-center tick.
