# Split Tracking

App id / session name: `split-tracking` (title "Tracking - Split", application
group). Proposal + decisions of record: `docs/proposals/split-tracking-app.md`.

## What it does

Two INDEPENDENT single-eye visual servos. The user drops one target on the
LEFT fovea view and one on the RIGHT; a switchable tracker (KCF / hybrid,
disparity-scope's engines) tracks each target with a configurable template
tile (512×512 default), and each mirror steers to keep ITS target at the
fovea frame center. The two sides never share state — there is no
stereo/vergence coupling (this is the distinction from disparity-scope, which
drives both mirrors from one center-camera target).

## Sources / leasing {#leasing}

`app/modules/split-tracking/session.ts` on `defineResourceSession`. Leases the
L/C/R triple via `acquireTriple` → `CalibratedTriple` (the calibration
conversions `conv.V2A`/`conv.A2V` + `undistort` feed the servo Jacobian).
`publishSerials` → `state.serials`; per-eye frame `size` published for the
overlays; L/R homography-undistort pipes advertised (`state.undistort`, convert
fallback when uncalibrated). LIFO teardown drains everything before
`releaseLeases`.

## Tracking {#tracking}

Per eye: `createChainedTracker` (kcf) / `createChainedHybridTracker` (hybrid)
from `core/Tracker`, tapping that eye's undistort (or convert) pipe. The engine
is drawer-switchable (`state.tracker_type`) with a self-contained hot swap
(release → create → consume → re-arm-iff-armed; the running type is written
back so the UI never advertises an engine that isn't live). Results drain via
`for await` into the pure `reduceResult` reducer (`tracking.ts`).

**Per-side lifecycle (independent).** Grabbing a side's target selector (drag
START) → `pauseTracker{eye}`: that eye un-arms, its mirror holds. Releasing
(drag END) → `armTarget{eye,center}`: `servo.reset()`, the tracker re-`arm`s at
`tileRect(center, tile, size)`, servoing resumes. Dragging one side never
touches the other.

The **tile** (`state.tile`, default 512×512, drawer-configurable
`MIN_TILE`..`MAX_TILE` = 64..1024) is the tracker template ROI passed to
`arm()`; `setTile` re-arms both armed sides live. It is drawn + labeled in each
view around the tracked center.

## Actuation {#actuation}

A JS control loop (manual-control's `openPosition` → `PositionInput.update`
model; NOT the native imm→compose chain — a perf follow-up). Each tracker
result: `errPx = trackedCenter − frameCenter` → per-eye `EyeServo` (PID over
the jInv-mapped volt error, per-tick clamp, anti-windup) → volt delta →
accumulate the eye's volt (clamped to the controller envelope) → push the
`{left,right}` pair. `onLost` stops that eye's servo and holds its mirror; no
controller / no calibration → `state.blocked` (tray-style reason) + a
lightweight retry.

### Jacobian {#jacobian}

`app/modules/split-tracking/jacobian.ts` (pure, unit-tested). A target at
fovea-pixel offset `p` sits at gaze angle `angle0 + p/focal` (small-angle
pinhole); to center it the mirror commands `A2V(angle0 + p/focal)`, so the
pixel→volt Jacobian is `d/dp[A2V(angle0 + p/focal)]` — a finite difference that
yields volt-per-px directly (no explicit inverse). Inputs per tick: `focal`
from `deriveFoveaIntrinsics(...).f`, `angle0 = conv.V2A[eye](volt)`, per-eye
`conv.A2V[eye]`. Degenerate/uncalibrated focal → zero matrix (servo holds, no
NaN to the mirror). **RIG-TUNABLE:** the per-axis pixel→angle signs and the
effective fovea zoom/scale depend on the camera↔mirror mounting; `FOVEA_TRACK_ZOOM`
and `SERVO_MAX_STEP_V` are the bench knobs.

## Capture + recording {#capture}

The shared mixins (`captureCommands/Telemetry`, `recordingCommands/Telemetry`)
+ renderer `Capture`/`Recording` facades; server `createRawRecording` +
`createCaptureHelper`/`rawTripleShot` over `left-fovea`/`center`/`right-fovea`
= `camera/<serial>/raw` (center intrinsic-convert). Capture ⟂ recording
(mutually exclusive), ported verbatim from calibrate-extrinsic.

## Renderer {#renderer}

`app/modules/split-tracking/index.vue`. L/R fovea `StreamView`s (theme L/R) +
a C context view, bound via `usePipeFrame`. Each fovea has a `PosView` target
selector (`:lim` = half frame size, `@select` → image px); drag-start fires
`pauseTracker`, drag-end fires `armTarget`. Overlays: the labeled tile box
(size annotated), a frame-center crosshair, the live tracked bbox/center. The
drawer carries the tracker-type segmented select, the tile-size input, PID gain
inputs, per-eye status, and capture/record controls.

## Pure modules (unit-tested, no addon) {#pure}

- `tracking.ts` — `tileRect`, `applyJInv`, `EyeServo` (PID), `reduceResult`,
  the shared `Eye`/`TileSize`/`PidGains`/`Mat2` types + `DEFAULT_*` constants.
- `jacobian.ts` — `eyeJInv` (above).
