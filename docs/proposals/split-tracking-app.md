# New app: Split Tracking (2026-07-14)

User request: a new renderer app "split tracking", based on
calibrate-extrinsic, where the user drops one target on the LEFT fovea view
and one on the RIGHT, a switchable disparity-scope tracker (KCF / hybrid)
tracks each target with a configurable tile (512×512 default, annotated in
the view), and each mirror INDEPENDENTLY steers to keep its target centered.
Views are capturable and recordable.

## Semantics (interpretation of record — correct here if unflagged)

- Two INDEPENDENT single-eye visual servos. Left fovea tracks the left
  target; right fovea tracks the right target. No stereo/vergence coupling
  (unlike disparity-scope, which drives both mirrors from ONE center-camera
  target). The two sides never touch each other's state.
- "track the center of the frame" = the CONTROL GOAL is to bring/keep the
  tracked target at the fovea frame CENTER. The 512×512 tile is the tracker
  template (the `arm()` ROI, disparity-scope's `kernel`), drawn in the view
  around the tracked center; the frame center is marked too.
- Per-side tracker lifecycle (user ruling 2026-07-14): grabbing a side's
  target selector (drag START) STOPS that side's tracker and holds its
  mirror; releasing (drag END) RE-INITIALIZES the tracker at the dropped
  point and resumes tracking + servo. Fully independent per side.

## Reuse map (from the exploration pass)

- **Scaffold / leasing / views:** calibrate-extrinsic. Lease the L/C/R triple
  — use `acquireTriple` → `CalibratedTriple` (`@orchestrator/calibration`;
  richer than extrinsic's raw `matchTriple`: bundles `conv`/`undistort`/A2V
  needed for the servo). `publishSerials` → `state.serials`; renderer binds
  each fovea view via `usePipeFrame(nodeId.undistort(serial) ?? nodeId.convert(serial))`.
- **Trackers:** `createChainedTracker(pipeId,name)` / `createChainedHybridTracker`
  from `core/Tracker` — one per eye, tapping that eye's undistort/convert
  pipe. `KcfTracker.arm(RECT.fromCenter(center, tile))` seeds; async-iterable
  `TrackResult { found, bbox, center, overridden }`. Engine hot-swap: the
  pure `swapTracker` pattern (disparity-scope tracker-swap.ts) — reimplemented
  self-contained here (no cross-module import), generic in the handle.
- **Target selector:** `PosView.vue` (`@select → Pos|null`), used per eye
  over the fovea view with `:lim` = half the frame size and `:pos` = target −
  center, so `@select` yields an image-pixel target. The 512² tile + center
  marker are SVG overlays on the `StreamView`.
- **Actuation:** a JS control loop (manual-control's `openPosition` →
  `PositionInput.update({left,right})` template) — NOT the native imm→compose
  chain (that's a perf follow-up). Each tracker result → per-eye pixel error
  (tracked center − frame center) → per-eye PID through the calibration
  Jacobian → volt delta → the eye's volt; push the `{left,right}` pair.
- **Capture + recording:** the mixins (`captureCommands/Telemetry`,
  `recordingCommands/Telemetry`) + `new Capture(session,ns)` /
  `new Recording(session,ns)` (renderer), `createRawRecording` +
  `createCaptureHelper`/`rawTripleShot` over `left-fovea`/`center`/`right-fovea`
  raw pipes (server) — exactly the calibrate-extrinsic wiring.

## Registration touch points (id = `split-tracking`, session = `split-tracking`)

Module dir `app/modules/split-tracking/` with contract/session/index.vue, then:
1. `app/lib/windows.ts` — APP_REGISTRY row: `"split-tracking": { title: "Tracking - Split", session: "split-tracking", group: "application" }`.
2. `app/src/windows/app-registry.ts` — `baseLoaders["split-tracking"] = () => import("@modules/split-tracking/index.vue")`.
3. `app/src/windows/WelcomeWindow.vue` — `iconOf["split-tracking"] = <icon>` (import from `./icons`; add the re-export in `app/src/windows/icons.ts` if new).
4. `app/orchestrator/index.ts` — import the session factory + `hub.add(splitTrackingSession(...seams))` + add to the `cameraOwning` array (it owns the triple).

## Pinned contract (`app/modules/split-tracking/contract.ts`)

```ts
export type Eye = "L" | "R";
export interface TileSize { w: number; h: number }
export interface PidGains { kp: number; ki: number; kd: number }
export const splitTracking = defineContract({
  state: {
    serials: {} as Partial<Record<"L"|"C"|"R", string>>,
    undistort: { L: null, R: null } as Record<Eye, string | null>, // advertised undistort pipe, else convert fallback
    tracker_type: "hybrid" as "hybrid" | "kcf",   // drawer switch (disparity-scope idiom)
    tile: { w: 512, h: 512 } as TileSize,          // tracker template + annotation; drawer-configurable
    gains: { kp: /*safe*/, ki: /*safe*/, kd: /*safe*/ } as PidGains, // shared per-eye PID; drawer-tunable
  },
  telemetry: {
    ready: false as boolean,
    size: { L: {width:0,height:0}, R: {width:0,height:0} } as Record<Eye, Size>,
    // per-eye live tracker readout (center/bbox in fovea image px, for overlays):
    tracked: { L: null, R: null } as Record<Eye, { center: Point2d|null; bbox: Rect|null; found: boolean } | null>,
    tracking: { L: false, R: false } as Record<Eye, boolean>, // servo engaged (armed & not dragging & not lost)
    volt: { L: {x:0,y:0}, R: {x:0,y:0} } as Record<Eye, Pos>,
    blocked: null as string | null,   // e.g. "no controller connected" (tray warning idiom)
    perf: { actuateMs: {mean:0,max:0} as Stat },
    ...captureTelemetry(),
    ...recordingTelemetry(),
  },
  frames: [] as const,  // views ride pipes
  commands: {
    armTarget: cmd<{ eye: Eye; center: Point2d }, void>(),   // drag END: (re)arm tracker at center px + resume servo
    pauseTracker: cmd<{ eye: Eye }, void>(),                  // drag START: stop tracker + hold mirror
    setTrackerType: cmd<{ type: "hybrid"|"kcf" }, void>(),
    setTile: cmd<TileSize, void>(),
    setGains: cmd<PidGains, void>(),
    ...captureCommands(),
    ...recordingCommands(),
  },
});
export type SplitTrackingContract = typeof splitTracking;
```

## Pinned pure module (`app/modules/split-tracking/tracking.ts`)

```ts
export const DEFAULT_TILE = 512; export const MIN_TILE = 64; export const MAX_TILE = 1024;
export const DEFAULT_GAINS: PidGains;
export const TRACKER_LOST_TOLERANCE: number;      // consecutive misses → lost
/** Arm ROI centered on `center`, clamped fully inside `frame` (never a
 *  partial/negative rect — the arm() precondition). */
export function tileRect(center: Point2d, tile: TileSize, frame: Size): Rect;
/** 2×2 [[a,b],[c,d]] volt-per-px inverse jacobian applied to a px error →
 *  volt error; the session supplies J from the calibration geometry. */
export type Mat2 = readonly [number, number, number, number];
export function applyJInv(errPx: Point2d, jInv: Mat2): Point2d;
/** Per-eye visual servo: PID over the (jInv-mapped) volt error, clamped to a
 *  per-tick volt step; integrator anti-windup; reset() on (re)arm. */
export class EyeServo {
  constructor(gains: PidGains, maxStepV: number);
  setGains(g: PidGains): void; reset(): void;
  /** returns the volt DELTA to add this tick (px error = tracked − center). */
  step(errPx: Point2d, jInv: Mat2, dtSec: number): Pos;
}
/** Per-eye TrackResult reducer (disparity-scope tracker-feed shape, single
 *  side): overridden→onDrag, armed&found→onTrack, else miss-count→onLost. */
export interface SideHandlers { onTrack(c: Point2d, b: Rect): void; onDrag(c: Point2d): void; onLost(): void }
export function reduceResult(r: {found:boolean;center:Point2d|null;bbox:Rect|null;overridden:boolean},
  armed: boolean, misses: number, handlers: SideHandlers): number; // new miss count
```
Fully unit-tested (tile clamp at all four edges, jInv apply, PID
convergence/anti-windup/clamp/reset, reducer routing incl. lost threshold).
`Mat2`/`Pos`/`Point2d`/`Rect`/`Size` from the existing geometry types.

## Session (`session.ts`) outline

`defineResourceSession("split-tracking", splitTracking, s => {...})`:
- Lease triple (`acquireTriple`), LIFO `releaseLeases` defer, `publishSerials`,
  publish per-eye frame `size`, advertise undistort pipes (extrinsic pattern).
- Per eye: `createChainedTracker`/`Hybrid` on `nodeId.undistort(serial)` (or
  convert), consumed via a `for await` drain into `reduceResult` with the
  side's handlers; hot-swap on `setTrackerType` via the self-contained swap
  ops (release→create→consume→re-arm-iff-armed), writing the running type
  back to state.
- Per eye `EyeServo`; compute the eye's `jInv` from the calibration geometry
  (finite-difference the per-eye V2A/A2V + the fovea intrinsics focal — same
  geometric basis as disparity-scope's `followVolts` Jacobian; NO hardware
  needed, it's the model). `onTrack(center)` → `errPx = center − frameCenter`
  → `servo.step` → accumulate the eye's volt → push `{left,right}` via
  `controllerNode().openPosition("split-tracking",…)`. `onLost` → stop
  servoing that eye (hold volt), `tracking.<eye>=false`, set `blocked`.
- `armTarget{eye,center}` → `servo.reset()`, `tracker.arm(tileRect(center,tile,size))`,
  mark armed, `tracking.<eye>=true`. `pauseTracker{eye}` → mark un-armed, hold
  volt, `tracking.<eye>=false` (tracker keeps running but its results are
  ignored while un-armed — or `releaseOverride`/idle; keep it simple: an
  `armed[eye]` gate around servoing, tracker re-`arm`ed on the next armTarget).
- `setTile` re-arms both armed sides live (kernel() idiom). `setGains` →
  `servo.setGains` both. Controller-absent → `blocked` + retry when it
  appears (manual-control trigger-retry idiom, lightweight).
- Capture + recording: `createRawRecording` (`left-fovea`/`center`/`right-fovea`
  → `camera/<serial>/raw`) + `createCaptureHelper`/`rawTripleShot` (graphInputs
  L/R undistort-or-convert, center convert); commands forward to the helpers;
  capture ⟂ recording mutually exclusive. Copy calibrate-extrinsic verbatim.

## Renderer (`index.vue`) outline

- `useSession(splitTracking, "split-tracking")`; `new Capture(session,"split-tracking")`,
  `new Recording(session,"split-tracking")` (title-bar buttons free).
- L and R fovea `StreamView`s (theme L/R) bound to `usePipeFrame`; a center
  `StreamView` for context. Each fovea view overlays: a `PosView`-based
  draggable target selector (`:lim` = half frame size, `:pos` = target −
  center; `@select` → image px), the 512² tile box (SVG rect at the tracked
  center, LABELED with its px size — "annotate this in the view"), a
  frame-center crosshair, and the live tracked bbox/center.
- Drag lifecycle: PosView pointer-DOWN (drag start) → `session.call("pauseTracker",{eye})`;
  pointer-UP (drag end, final px) → `session.call("armTarget",{eye,center})`.
  The marker follows the tracked center between drags; the user grabs it to
  reposition.
- Drawer: tracker-type segmented select (Hybrid / KCF; disparity-scope
  idiom), tile-size number input (px, MIN..MAX), PID gain inputs, per-eye
  status rows (tracking / lost / paused), capture/record controls. Follow the
  borderless-inline design rule.

## Lanes (parallel, pinned interfaces, NO file overlap)

- **PURE:** `tracking.ts` + `app/test/split-tracking-*.test.ts`.
- **SESSION:** `contract.ts`, `session.ts`, `app/orchestrator/index.ts`,
  `app/lib/windows.ts`, `app/src/windows/app-registry.ts`.
- **UI:** `index.vue`, `app/src/windows/WelcomeWindow.vue` (+ `icons.ts` if a
  new icon).

## Docs

`docs/spec/split-tracking.md` (new), `docs/manual/` page, stage-f "Split
Tracking" RIG checklist (the servo Jacobian sign/gain, per-side independence,
drag-stop/reseed, tile annotation, capture/record), proposals/README row.

## AS SHIPPED (2026-07-14, three-lane wave)

Shipped as designed; gates green (vue-tsc, vitest 1478/1478 across 138 files,
vite build, boundaries). Spec: `docs/spec/split-tracking.md`. Decisions of
record:

- **PURE** (`tracking.ts` + 29 tests): `EyeServo` PID with conditional-
  integration anti-windup, per-tick ±clamp, `dtSec≤0`→P-only; `tileRect`
  shifts (not shrinks) into the frame, oversize→frame-centered, integer px;
  `reduceResult` single-side routing, re-firing `onLost` each armed miss past
  the threshold (spec-pinned). `TileSize`/`PidGains` are `type` aliases (an
  `interface` breaks the contract `Serializable` constraint). `DEFAULT_GAINS
  = {kp:0.15, ki:0.01, kd:0.02}` (conservative, RIG-tunable). A
  `DEFAULT_MAX_STEP_V=1.0` export is unused (session keeps its own 5.0 V knob
  — dual source, cosmetic; unify in a later sweep).
- **SESSION** (`contract.ts`, `session.ts`, `jacobian.ts` + 5 tests, +the 4
  registration edits): seams `splitTrackingSession(asBroker(Pipe),
  undistortSeam, rawPipes, compressSeam)`; in `cameraOwning`. jInv derived by
  finite-differencing `A2V(angle0 + p/focal)` per eye (volt-per-px directly;
  zero-focal guard; signs/`FOVEA_TRACK_ZOOM`/`SERVO_MAX_STEP_V=5V` RIG-tunable).
  Teardown (LIFO): recording.stop → capture drain → pipes → posInput.close →
  tracker.release → releaseLeases. Capture graphInputs use the RAW pipes
  (`camera/<serial>/raw`) that `rawTripleShot` actually reads, center=convert.
  `onDrag` is a no-op (split drags are session commands, not tracker
  `override()`).
- **UI** (`index.vue`, WelcomeWindow icon `faCrosshairs`, `icons.ts`): PosView
  selectors below each fovea view; drag-start detected as the first non-null
  `@select`, drag-end as the `null` release → `pauseTracker`/`armTarget`;
  tile/center/bbox drawn in the FrameView SVG (pixel-accurate viewBox), tile
  labeled with its px size.

RIG-GATED (stage-f): the servo Jacobian sign/scale + gain on real mirrors,
per-side independence + drag-stop/reseed, tile annotation accuracy, the
non-square-fovea `lim` mapping (UI's `lim=width/2` is 1:1 only for a square
crop; `tileRect` clamps regardless), capture/record of the three streams.
