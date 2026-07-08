// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side port of the renderer's `calibrate-extrinsic/tracker.ts`
// (`Tracker` class + `actuate()`), shared by calibrate-extrinsic,
// calibrate-distortion, and calibrate-drift (docs/history/refactor/orchestrator.md
// §7.1 S1b) — the original was cross-module-imported by all three, so it
// lives here as orchestrator infra (like `actuation.ts`/`calibration.ts`)
// rather than co-located in one of the three consumer modules.
//
// Vue-free port: the original class used `ref`/`shallowRef`/`computed` for
// its public getters and `EventTarget`/`dispatchEvent` for the "new
// detection" signal — replaced with plain fields and a callback-list
// (`onDetection`), matching every other session's style (`registry.ts`'s
// `onFrame`/`onView`). Runs its own `detector.stream(camera.stream, scale)`
// consumer, same concurrent-raw-stream pattern calibrate-intrinsic's marker
// mode already established for this exact "MarkerDetector only takes a raw
// Frame/Stream<Frame>, not a Mat" constraint.

import {
  MarkerDetector,
  cornerSubPix,
  findHomography,
  gaussian,
  projectHomography,
  type MarkerDetectResult,
  type MarkerDetectResults,
} from "core/Vision";
import type { Camera, Frame } from "core/Aravis";
import type { Point2d, Point3d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { avg } from "@lib/util/math";
import { clamp } from "@lib/util/math";
import { bilinearInterpolate, CORNER_OBJ_POINTS, getInternalObjectPoints } from "@lib/marker";
import abortableNext from "@lib/abortable.next";
import { report } from "./diagnostics.js";
import { activeController } from "./controller.js";
import { PID2D, type PidParams } from "@lib/pid";
import { nodeId } from "@lib/orchestrator/graph-contract";
import {
  createPidNode,
  outputOf,
  type OverrideSlot,
  type PidNodeHandle,
} from "./pid-node.js";

export type TrackerRecord = { img_pts: Point2d[]; obj_pts: Point3d[] };
export type TrackerTarget = MarkerDetectResult & TrackerRecord;
type CenterAbsolute = { x: number; y: number; width: number; height: number };

/** Tracks one marker (by id) on one camera's raw stream, with subpixel
 *  homography refinement for its 4 outer + N internal corners. */
export class MarkerTracker {
  targetId: number;
  private lostCount = 0;
  private _target: TrackerTarget | null = null;
  private _otherTargets: MarkerDetectResult[] = [];
  // Implicit per-yield ref, released when superseded or on `stop()` — same
  // bookkeeping as calibrate-intrinsic's `latestMarker` (see that file's
  // `capture()` comment for the full accounting). A caller wanting to retain
  // a specific tick's frame past that point must `.ref()` it themselves.
  private lastFrame: Frame | null = null;
  private task: ReturnType<typeof abortableNext> | null = null;
  private readonly listeners = new Set<() => void>();

  /** The serial of the camera this tracker consumes — the graph-node key for
   *  its marker-detection source (`nodeId.detect(serial)`), used by `startServo`
   *  to wire the servo's PID node input edge. */
  get serial(): string {
    return this.camera.serial;
  }
  get target(): TrackerTarget | null {
    return this._target;
  }
  get otherTargets(): readonly MarkerDetectResult[] {
    return this._otherTargets;
  }
  /** The frame the current `target`/`otherTargets` were detected in — valid
   *  until the next detection tick or `stop()`; `.ref()` to retain longer. */
  get frame(): Frame | null {
    return this.lastFrame;
  }
  get centerRelative(): Point2d | null {
    const t = this._target;
    if (!t) return null;
    const { width, height } = t;
    return { x: avg(t.map((p) => p.x)) / width - 0.5, y: avg(t.map((p) => p.y)) / height - 0.5 };
  }
  get centerAbsolute(): CenterAbsolute | null {
    const t = this._target;
    if (!t) return null;
    const { width, height } = t;
    return { x: avg(t.map((p) => p.x)), y: avg(t.map((p) => p.y)), width, height };
  }

  /** Fires after every detection tick (matched or not) — mirrors the
   *  original's `"detection"` DOM event. */
  onDetection(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  constructor(
    private readonly camera: Camera,
    private readonly detector: MarkerDetector = new MarkerDetector("4X4_50"),
    targetId = 0,
    private readonly scale = 1.0,
    private readonly internal = false,
  ) {
    this.targetId = targetId;
    this.start();
  }

  private async fitSubPix(
    frame: Frame,
    result: MarkerDetectResult,
    iterations = 3,
  ): Promise<TrackerTarget> {
    const gray = await frame.view("Mono8");
    const blurred = gaussian(gray, 11, 2.0);
    const obj_pts = [...CORNER_OBJ_POINTS];
    if (this.internal)
      for (const { x, y } of getInternalObjectPoints(this.detector.pattern(result.id)))
        obj_pts.push({ x, y, z: 0.0 });
    let img_pts = bilinearInterpolate(result, obj_pts);
    if (this.internal)
      for (let i = 0; i < iterations; i++) {
        const H = findHomography(obj_pts, img_pts);
        const proj = projectHomography(H, obj_pts);
        img_pts = await cornerSubPix(blurred, proj);
      }
    return Object.assign(img_pts.slice(0, 4), {
      id: result.id,
      width: result.width,
      height: result.height,
      img_pts,
      obj_pts,
    }) as TrackerTarget;
  }

  private async handleDetections(detections: MarkerDetectResults): Promise<void> {
    let target: TrackerTarget | null = null;
    const others: MarkerDetectResult[] = [];
    for (const d of detections) {
      if (target === null && d.id === this.targetId) target = await this.fitSubPix(detections.frame, d);
      else others.push(d);
    }
    if (target !== null) {
      this._target = target;
      this.lostCount = 0;
    } else {
      this.lostCount++;
      if (this.lostCount >= 5) this._target = null;
    }
    this._otherTargets = others;
  }

  private start(): void {
    const stream = this.detector.stream(this.camera.stream, this.scale);
    this.task = abortableNext(async (ctx) => {
      for (const detections of ctx.iter(stream)) {
        if (!detections) {
          await new Promise((r) => setTimeout(r, 0));
          continue;
        }
        if (this.lastFrame && this.lastFrame !== detections.frame) this.lastFrame.release();
        this.lastFrame = detections.frame;
        await this.handleDetections(detections);
        for (const fn of this.listeners) fn();
      }
    });
    // Same expected-vs-real-error split as calibrate-intrinsic's marker task
    // — `ctx.iter()` throws `AbortedError` cooperatively on `.abort()`.
    this.task.catch((e) => {
      if (e instanceof abortableNext.AbortedError) return;
      report("marker-tracker", e instanceof Error ? e.message : String(e));
    });
  }

  stop(): void {
    this.task?.abort();
    this.task = null;
    this.lastFrame?.release();
    this.lastFrame = null;
  }
}

/** Overshoot-guarded return-to-origin step: moves `p` (the signed error from
 *  origin) toward zero by up to `kp`, never past it — a SATURATING step, not a
 *  linear gain (unchanged from the original hand-rolled servo). */
function backToCenter(p: number, kp: number): number {
  return -clamp(Math.sign(p) * kp, [Math.min(0, p), Math.max(0, p)]);
}

/** Topology-only downstream node id for each eye's pid → controller edge. The
 *  servo actuates the shared `activeController()` (no per-port MEMS id reaches
 *  here), so this is a stable placeholder the wiring shim renders as a
 *  `controller` node — same convention as disparity-scope's CONTROLLER_NODE_ID. */
const CONTROLLER_NODE_ID = "controller";

export interface ServoOptions {
  kp?: number;
  originLeft?: () => Point2d;
  originRight?: () => Point2d;
  /** Manual override, checked every tick — takes priority over the
   *  tracker-driven command (matches the original's drag-to-override). Bridged
   *  into the per-eye PID node's ruled override slot (see {@link startServo}). */
  overrideLeft?: () => Pos | null;
  overrideRight?: () => Pos | null;
  /** Composing window/session id for the servo's graph nodes (`win/<owner>/...`).
   *  Callers that don't pass one get a generic default — a follow-up threads the
   *  real session id through here once the call sites migrate. */
  owner?: string;
}

export interface Servo {
  stop(): void;
  /** The per-eye graph-visible PID controller nodes (null for an eye with no
   *  tracker). Exposed so a follow-up can drive each node's override slot from
   *  the reusable `pidOverride` contract command instead of the legacy
   *  `overrideLeft`/`overrideRight` thunks. */
  readonly nodes: {
    left: PidNodeHandle<Pos> | null;
    right: PidNodeHandle<Pos> | null;
  };
  /** Shortcut to each node's override slot (null for an absent eye). */
  readonly override: {
    left: OverrideSlot<Pos> | null;
    right: OverrideSlot<Pos> | null;
  };
}

/**
 * Visual-servo the controller toward `left`/`right` trackers' targets (or
 * back toward `origin*` when no target is visible) — the original `actuate()`
 * control loop, rebuilt as a pair of graph-visible PID controller NODES
 * (docs/proposals/pid-nodes-and-view-replumb.md). Runs against the
 * orchestrator's shared `activeController()` (same holder tracking-single/
 * manual-control's `startActuationLoop` reads), not a passed-in facade — the
 * caller doesn't own enable/disable bracketing beyond calling `stop()`.
 *
 * CONTROL CORE. The original hand-rolled `pos += rel*kp` is a VELOCITY-FORM
 * update: the running command is `previous + gain·error`. Mapped onto the
 * uniform {@link PidParams} that is `ki = kp` with `kp = kd = 0` — the parallel
 * PID output then collapses to its (unbounded, as the original never clamped)
 * integrator, so `PID2D.step(rel)` returns `base + kp·rel` exactly (see
 * @lib/pid). Each eye owns a `PID2D` (independent x/y integrators, exactly the
 * original's component-wise `{x,y}` update); dt is 1 per detection tick. The
 * integrator is RE-BASED on the live controller position (`c.pos.left/right`)
 * every tick — the SAME base the original read — so the command sequence
 * (including its DAC-quantized feedback) is bit-identical. The default `kp`
 * (16.0) and the per-caller value (calibrate-drift passes 10.0) carry through
 * unchanged as `ki`.
 *
 * OVERRIDE. The legacy per-eye `overrideLeft`/`overrideRight` thunks are bridged
 * into each node's RULED override slot: a returned pose engages/updates it, a
 * null RELEASES it. While engaged, `node.step` skips the control law and resets
 * that eye's integrator each tick (no windup builds behind the drag); the output
 * is the pinned pose. On release the node's `seed` reseeds the integrator from
 * the LAST override so control resumes FROM the released pose — velocity-form
 * continuity, no snap-back (the behavioral guarantee the ruled slot adds; the
 * re-base already resumes from the dragged `c.pos`, and the seed keeps that true
 * even if a future migration makes the integrator authoritative). The per-eye
 * grain is preserved because each eye is a separate node: dragging ONE eye pins
 * it while the other keeps servoing — a single all-or-nothing slot could not.
 */
export function startServo(
  left: MarkerTracker | undefined,
  right: MarkerTracker | undefined,
  opts: ServoOptions = {},
): Servo {
  const { kp = 16.0 } = opts;
  const owner = opts.owner ?? "marker-servo";
  const pending: { left?: Pos; right?: Pos } = {};
  const disposers: Array<() => void> = [];
  let running = true;
  let enabledByUs = false;

  // Velocity-form params (see the doc comment): ki = kp, kp = kd = 0, unbounded.
  const axis = (): PidParams => ({ kp: 0, ki: kp, kd: 0 });
  const makePid = (): PID2D => new PID2D({ x: axis(), y: axis() });

  /** Create the graph-visible PID node for one eye. Input edge = the eye's
   *  marker-detection source (the tracker runs its own off-loop
   *  `detector.stream`; there is no separately-registered detect brick, so
   *  `camera/<serial>/detect` renders as a placeholder the wiring shim files
   *  under this node — same treatment as the controller placeholder). Output
   *  edge = the shared MEMS controller node. `seed` reseeds the integrator from
   *  the last override for release continuity. */
  const makeNode = (
    side: "left" | "right",
    tracker: MarkerTracker,
    pid: PID2D,
  ): PidNodeHandle<Pos> =>
    createPidNode<Pos>({
      id: nodeId.win(owner, "pid", side),
      kind: "pid",
      owner: nodeId.win(owner),
      inputs: [{ from: nodeId.detect(tracker.serial), port: "marker", type: { kind: "detect" } }],
      outputs: [{ to: CONTROLLER_NODE_ID, port: side }],
      controllers: { pos: pid },
      seed: (v) => {
        pid.value = v;
      },
    });

  const pidLeft = left ? makePid() : null;
  const pidRight = right ? makePid() : null;
  const nodeLeft = left && pidLeft ? makeNode("left", left, pidLeft) : null;
  const nodeRight = right && pidRight ? makeNode("right", right, pidRight) : null;

  /** The original per-eye control law, now the PID node's control fn (run by
   *  `node.step` only when the override is NOT engaged). Re-bases the integrator
   *  on the live `base` (= `c.pos.<eye>`), then either steps `pos += rel*kp`
   *  (marker visible) or walks back toward `origin` via `backToCenter` (a
   *  saturating step, seeded directly into the integrator — not a linear ki·e
   *  term). */
  function control(base: Pos, rel: Point2d | null, origin: Point2d, pid: PID2D): Pos {
    pid.value = base;
    if (rel) return pid.step(rel);
    const cmd: Pos = {
      x: base.x + backToCenter(base.x - origin.x, kp),
      y: base.y + backToCenter(base.y - origin.y, kp),
    };
    pid.value = cmd;
    return cmd;
  }

  function onDetection(
    side: "left" | "right",
    tracker: MarkerTracker,
    pid: PID2D,
    node: PidNodeHandle<Pos>,
    overrideThunk: (() => Pos | null) | undefined,
    originThunk: (() => Point2d) | undefined,
  ): void {
    const c = activeController();
    if (!c) return;
    // Bridge the legacy per-eye override thunk into the node's ruled slot: a pose
    // engages/updates it (idempotent), a null RELEASES it (release is a no-op
    // when not engaged, so polling every tick is safe). [Follow-up: the call
    // sites move to the `pidOverride` contract driving `node.override` directly,
    // and this thunk bridge retires.]
    const o = overrideThunk?.() ?? null;
    if (o) node.override.engage(o);
    else node.override.release();
    const base = side === "left" ? c.pos.left : c.pos.right;
    const origin = originThunk?.() ?? { x: 0, y: 0 };
    // `node.step` runs `control` UNLESS overridden — then it resets `pid` and
    // returns the pinned pose, so `pending` carries the override-or-servo command
    // resolved for this tick (the old actuation-loop `override ?? pending` poll).
    pending[side] = outputOf(node.step(() => control(base, tracker.centerRelative, origin, pid)));
  }

  if (left && pidLeft && nodeLeft)
    disposers.push(
      left.onDetection(() =>
        onDetection("left", left, pidLeft, nodeLeft, opts.overrideLeft, opts.originLeft),
      ),
    );
  if (right && pidRight && nodeRight)
    disposers.push(
      right.onDetection(() =>
        onDetection("right", right, pidRight, nodeRight, opts.overrideRight, opts.originRight),
      ),
    );

  void (async () => {
    while (running) {
      const c = activeController();
      if (!c) {
        enabledByUs = false;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      try {
        if (!c.enabled) {
          await c.enable();
          enabledByUs = true;
          await c.actuate({
            left: opts.originLeft?.() ?? { x: 0, y: 0 },
            right: opts.originRight?.() ?? { x: 0, y: 0 },
          });
        }
        if (pending.left || pending.right) {
          // `pending` already carries the override-or-servo command (resolved in
          // `onDetection` through each eye's PID node), so the loop just flushes
          // it — the old `overrideLeft?.() ?? pending` poll now lives at the node.
          await c.actuate({ left: pending.left, right: pending.right });
          delete pending.left;
          delete pending.right;
        } else {
          await new Promise((r) => setTimeout(r, 1));
        }
      } catch {
        enabledByUs = false;
      }
    }
  })();

  return {
    nodes: { left: nodeLeft, right: nodeRight },
    override: {
      left: nodeLeft?.override ?? null,
      right: nodeRight?.override ?? null,
    },
    stop() {
      running = false;
      for (const d of disposers) d();
      nodeLeft?.dispose();
      nodeRight?.dispose();
      if (enabledByUs) {
        activeController()?.disable();
        enabledByUs = false;
      }
    },
  };
}
