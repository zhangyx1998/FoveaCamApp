# PID nodes + disparity-scope view re-plumb (directive 2026-07-08)

User directive (rig finding + architecture ruling), verbatim intent:

1. **Undistort nodes are still not in place** for disparity-scope. Finding
   confirmed in code: the session connects `camera/<serial>/convert` pipes
   directly; the kernel warps L/R itself (`wrapPerspective`, homographies
   pushed by main at volt-telemetry cadence) and ONLY when `state.wrap` is
   on — with it off the L/R views are RAW converted frames. Nobody
   advertises `camera/<serial>/undistort` in this app, hence no undistort
   nodes in the graph.
2. **The scope kernel bottlenecks view fps** (rig: renderer 36–40 fps vs
   camera 60): every displayed view is a kernel output frame. RULING: views
   source INDEPENDENTLY from their corresponding undistort nodes; the
   disparity-scope node's output feeds ONLY the PID controller node.
3. **PID controller extracted into its own node(s)**, consuming the scope's
   output — the projected center positions of the foveas on the undistorted
   wide view — and responsible for updating its outputs.
4. **Uniform, reusable PID parameter interface.** A **PID-2D** variant takes
   a `{ x, y }` point input with separate x/y parameters.
5. **Override interface** on PID controllers, exposed to the renderer as a
   REACTIVE PROXY. While overridden: PID state held reset, output = override
   value. On release: the latest override value seeds the controller's
   initial output (velocity-form integrator ⇒ `reset(lastOverride)` gives
   output continuity — no jump).

## Target topology (what the graph must show)

```
camera/L/convert ─→ camera/L/undistort(H) ──┬─→ renderer L view (pipe, direct)
                                            └─→ win/disparity-scope/disparity ─┐
camera/C/convert ─→ camera/C/undistort(cal) ┬─→ renderer C view (pipe, direct) │
                                            └─→ (scope, wide input) ───────────┤
camera/R/convert ─→ camera/R/undistort(H) ──┬─→ renderer R view (pipe, direct) │
                                            └─→ (scope) ───────────────────────┤
                                                                                ▼
                                              win/disparity-scope/pid (vergence controller)
                                                                                │
                                                                     controller/<port> (MEMS)
```

- L/R undistort = the existing HOMOGRAPHY variant
  (`advertiseHomographyUndistortPipe` + `startHomographyFeeder` sampling
  `A2H∘V2A(volts)` — same seam tracking-single uses). Until samples flow the
  brick passes through (honest `passthrough` meter).
- C undistort = the existing INTRINSIC variant (`advertiseUndistortPipe`,
  cal from the acquired triple). The scope's template match + the projected
  positions now live on the UNDISTORTED wide view (P2A on it is linear).
- The kernel consumes the three UNDISTORT pipes (broker.connect — demand
  propagation keeps the bricks + converter awake). It no longer receives
  homography params and never emits L/R/C passthrough frames. It keeps its
  DIAGNOSTIC frames (`center.sliced`, `center.disparity`, `guide`,
  `match_left/right`) on `session.frame` — they are the scope's product, not
  a view relay.
- Scope OUTPUT (the only thing the control path consumes):
  `projection = { l: Point2d, r: Point2d, target: Point2d, ox, oy, scores }`
  — matched fovea centers + target on the undistorted wide frame, wide-frame
  pixels (full-res; strip offsets already applied).

## PID node design (worker A)

`@lib/pid` (Vue-free, stays Vue-free):

```ts
/** Uniform, serializable PID parameter record — the ONE reusable shape. */
export interface PidParams {
  kp: number; ki: number; kd: number;
  limits?: [number, number];
  integralLimits?: [number, number];
}
class PID { …existing…; setParams(p: PidParams): void }

/** 2D variant: { x, y } input, SEPARATE per-axis params. */
export interface Pid2dParams { x: PidParams; y: PidParams }
export class PID2D {
  constructor(p?: Partial<Pid2dParams>);
  setParams(p: Partial<Pid2dParams>): void;
  step(error: Point2d, dt?: number): Point2d;
  get value(): Point2d;  set value(v: Point2d);
  reset(value?: Point2d): void;
}
```

Orchestrator `pid-node.ts` — a graph-visible controller node wrapper
(`createPidNode(opts)`), NOT per-frame JS work (scalar math at scope result
rate; thin-coordinator rule intact):

```ts
interface PidNodeOptions<V> {
  id: string;                        // e.g. nodeId.win("disparity-scope", "pid")
  kind: "pid";
  inputs: { from: string; port: string }[]; // e.g. scope node id
  outputs: { to: string; port: string }[];  // e.g. controller node id
  controllers: Record<string, PID | PID2D>; // named DOFs
}
interface PidNodeHandle<V> {
  step(fn: () => V): V | OverrideHeld<V>;  // runs fn unless override engaged
  readonly override: OverrideSlot<V>;
  report(): NodeReport;                     // + registerGraphWiring lifetime
  dispose(): void;
}
```

Override slot semantics (the RULED part):
- `engage(v)` / `update(v)` (idempotent engage), `release()`.
- While engaged: every `step()` SKIPS the control fn, RESETS all named
  controllers (`reset()` each tick — state held at zero), and the node
  output is the override value.
- `release()`: controllers seeded via a caller-provided
  `seed(lastOverride)` hook (each DOF derives its integrator from the last
  override value) — output continuity guaranteed.

Renderer reactive proxy (client lib, reusable contract fragment):
- Contract state carries `pidOverride: { engaged: boolean, value: V | null }`
  + command `pidOverride({ value } | { release: true })`.
- `usePidOverride(session)` returns a reactive proxy: assigning
  `proxy.value = {x, y}` sends engage/update; `proxy.release()` releases;
  `proxy.engaged` mirrors state. Renderer drag code writes the proxy,
  nothing else.

## Disparity re-plumb (worker B)

- session.ts: advertise the three undistort pipes on activate (C intrinsic
  from `triple.undistort.calibration`; L/R homography + feeder from volts —
  reuse `homographyParams` math via the shared `conversionComputeH` helper);
  retire on idle. Kernel `PipeInput`s switch to the undistort pipe ids.
- vision.ts: drop `homographyL/R`, `wrap`, `wrapPerspective`, and the
  L/R/C output frames; foveas arrive pre-warped. Tile math unchanged
  (input IS the aligned fovea now). Emit `projection` in values (see
  contract above). Keep sliced/disparity/guide/match frames.
- vergence.ts `stepVergence`: unchanged math, but packaged INSIDE the PID
  node's control fn: pan → `PID2D`, verge + v_shift → `PID` (uniform params
  from `tuning`); input = scope `projection`; output = `{l, r}` volts.
- Pointer drag → `override.engage(rayVolts)`-style path through the PID
  node's override slot (target still goes to the kernel for the
  tracker/strip). On release, seeding reproduces today's "start from the
  dragged ray" behavior EXACTLY (pan seeds `ray − aT`, verge/v_shift keep
  their reconstruction values — worker derives the exact seed from
  `stepVergence`'s inverse).
- Graph wiring: scope node inputs = the three undistort pipe ids; new
  `win/disparity-scope/pid` node (kind "pid") with edges scope→pid and
  pid→`controller/<port>` when connected.

## Renderer (worker C)

- index.vue: L and R main views switch to `usePipeFrame` on
  `camera/<serial>/undistort` (serials from published leases — same
  mechanism as the current raw-C pipe view). The raw-C view stays on
  convert; the CENTER main view may also read the undistort pipe directly.
  Views must render at pipe rate with the kernel busy — that is the point.
- Drag path: write the PID override proxy (worker A's `usePidOverride`),
  keep sending `target` for tracker/strip placement.
- Telemetry `pids` readout now comes from the PID node's report (same
  numbers, new source); UI unchanged otherwise.

## Non-goals / kept behaviors

- No firmware change. No core/C++ change expected (undistort bricks +
  ParamRing land as-is); if a brick gap appears, STOP and report.
- `state.wrap` dies with the kernel warp (views are always undistorted now);
  contract removes it (breaking OK — converge at milestone).
- Actuation loop cadence, telemetry shapes (except noted), KCF behavior,
  tuning knobs all unchanged.

## Rig-gated (append to stage-f.md at close)

- Undistort nodes visible in the disparity graph; view fps at camera rate
  while the kernel meters lower; scope→pid→controller chain rendered.
- Undistorted L/R views track mirror pose (feeder H) with no wrap toggle.
- Drag override: mirrors follow the drag; release resumes control with no
  jump (seeded output).
