# Split Tracking

App id / session name: `split-tracking` (title "Tracking - Split", application
group).

## What it does

Two INDEPENDENT single-eye visual servos. Per eye, the user STEERS THE MIRROR
with a PosView voltage pad (manual-control's `splitEye` idiom) to bring the
desired target into the CENTER of the fovea view; on release, a switchable
tracker (KCF / hybrid, disparity-scope's engines) initializes on the FIXED
512×512 center tile and the mirror servos to keep whatever is now centered at
the center. The two sides never share state — there is no stereo/vergence
coupling (this is the distinction from disparity-scope, which drives both
mirrors from one center-camera target).

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

**Per-side lifecycle (independent).** Dragging a side's PosView (voltage pad)
→ `steerEye{eye,volt}`: that eye un-arms and its mirror is driven directly to
the commanded volt (manual steering). Releasing (drag END) → `armCenter{eye}`:
`servo.reset()`, the tracker `arm`s at `tileRect(frameCenter, tile, size)` —
the FIXED center tile — and the servo engages. Dragging one side never touches
the other. (`armEye` is the single arm helper; the swap re-arm and `setTile`
also arm at the center.)

The **tile** (`state.tile`, default 512×512, drawer-configurable
`MIN_TILE`..`MAX_TILE` = 64..1024) is the tracker template ROI, always centered
in the frame; `setTile` re-arms both armed sides live. It is drawn + labeled at
the frame center.

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
NaN to the mirror). **Hardware-tunable:** the per-axis pixel→angle signs and the
effective fovea zoom/scale depend on the camera↔mirror mounting; `FOVEA_TRACK_ZOOM`
and `SERVO_MAX_STEP_V` are the bench knobs tuned on the hardware rig.

## Capture + recording {#capture}

The shared mixins (`captureCommands/Telemetry`, `recordingCommands/Telemetry`)
+ renderer `Capture`/`Recording` facades; server `createRawRecording` +
`createCaptureHelper`/`rawTripleShot` over `left-fovea`/`center`/`right-fovea`
= `camera/<serial>/raw` (center intrinsic-convert). Capture ⟂ recording
(mutually exclusive), ported verbatim from calibrate-extrinsic.

## Renderer {#renderer}

`app/modules/split-tracking/index.vue`. L/R fovea `StreamView`s (theme L/R) +
a C context view, bound via `usePipeFrame`. Each fovea has a `PosView` VOLTAGE
pad (`:pos` = `telemetry.volt[eye]`, `:lim` = `controller.dv`, `@select` →
volt); a non-null steer fires `steerEye{eye,volt}`, the `null` release fires
`armCenter{eye}`. Overlays (fixed at frame center): the labeled 512² tile box,
a center crosshair, and the live tracked bbox/center. The drawer carries the
tracker-type segmented select, the tile-size input, PID gain inputs, per-eye
status (Steering / Tracking / Lost / Paused / Idle), and capture/record
controls.

## Pure modules (unit-tested, no addon) {#pure}

- `tracking.ts` — `tileRect`, `applyJInv`, `EyeServo` (PID), `reduceResult`,
  the shared `Eye`/`TileSize`/`PidGains`/`Mat2` types + `DEFAULT_*` constants.
- `jacobian.ts` — `eyeJInv` (above).
