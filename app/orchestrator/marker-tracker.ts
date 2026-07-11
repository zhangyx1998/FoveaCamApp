// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side Vue-free port of the renderer's calibrate-extrinsic/tracker.ts
// (Tracker class + actuate()), shared by calibrate-extrinsic/-distortion/-drift, so it
// lives here as orchestrator infra rather than in one consumer module. Runs its own
// detector.stream(camera.stream, scale) consumer (MarkerDetector needs a raw
// Frame/Stream, not a Mat) and signals via a callback-list (onDetection).
// spec: docs/spec/calibration.md#marker-tracker

import {
  MarkerDetector,
  cornerSubPix,
  findHomographyAsync,
  gaussianAsync,
  projectHomography,
  type MarkerDetectResult,
  type MarkerDetectResults,
} from "core/Vision";
import type { ProbeSnapshot } from "core/Pipe";
import type { Camera, Frame } from "core/Aravis";
import type { Point2d, Point3d } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";
import { avg } from "@lib/util/math";
import { clamp } from "@lib/util/math";
import { bilinearInterpolate, CORNER_OBJ_POINTS, getInternalObjectPoints } from "@lib/marker";
import abortableNext from "@lib/abortable.next";
import { report } from "./diagnostics.js";
import { controllerNode, type PositionPair } from "./controller-node.js";
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
  /** First-failure latch for the fitSubPix degradation report (per tracker). */
  private fitFailed = false;
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
    // B-24 meter name for the native detection thread (graph node ids ARE
    // meter names). Defaults to `nodeId.detect(serial)` — exactly the id the
    // sessions' registerGraphWiring rows use (calibrate-extrinsic 2026-07-11),
    // so the folded stats key onto the registered detect nodes with no
    // caller changes. Overridable for callers with a different node scheme.
    private readonly meterName: string = nodeId.detect(camera.serial),
  ) {
    this.targetId = targetId;
    this.start();
  }

  /** Out-of-loop probe of the native detection thread's meter (the shared
   *  ProbeSnapshot shape — folds into `perfSnapshot.workloads` via
   *  `registerNativeProbe`). Null before start and after stop (the native
   *  closure weak-captures the stream). Sessions that register this tracker's
   *  detect node feed it as `{ [nodeId.detect(serial)]: tracker.probe }`. */
  get probe(): ProbeSnapshot | null {
    return this.stream?.probe() ?? null;
  }

  /** The live native detection stream (held for `probe`); null once stopped. */
  private stream: ReturnType<MarkerDetector["stream"]> | null = null;

  private async fitSubPix(
    frame: Frame,
    result: MarkerDetectResult,
    iterations = 3,
  ): Promise<TrackerTarget> {
    const obj_pts = [...CORNER_OBJ_POINTS];
    if (this.internal)
      for (const { x, y } of getInternalObjectPoints(this.detector.pattern(result.id)))
        obj_pts.push({ x, y, z: 0.0 });
    let img_pts = bilinearInterpolate(result, obj_pts);
    if (this.internal) {
      // The blur feeds ONLY this refinement branch — the wide (external)
      // tracker computed and discarded it every tick (review 2026-07-11).
      // ASYNC variants (review #7, the finding's remaining half): the
      // full-frame blur and the up-to-3× RANSAC fits below used to run
      // SYNCHRONOUSLY on the orchestrator loop every detection tick — they
      // now run on the AsyncTask worker (gaussianAsync/findHomographyAsync,
      // same math), leaving only O(points) JS arithmetic on the loop. The
      // 89e462c bounds/degrade semantics are unchanged. (`gray` is the
      // view's OWNED copy on the electron/cage build, so the async blur
      // never reads freed frame memory.)
      const gray = await frame.view("Mono8");
      const blurred = await gaussianAsync(gray, 11, 2.0);
      const [rows, cols] = blurred.shape;
      // Projected interior points EXTRAPOLATE and can land outside the
      // frame for an edge/tilted marker; cv::cornerSubPix ASSERTS on any
      // out-of-rect point (rig crash 2026-07-11, cornersubpix.cpp:99).
      // Refine only the in-bounds subset, keep raw projections for the
      // rest, and fit the next H from the refined pairs alone (exact-fit
      // extrapolations would only anchor the fit to its previous estimate).
      let fitObj = obj_pts;
      let fitImg = img_pts;
      for (let i = 0; i < iterations; i++) {
        const H = await findHomographyAsync(fitObj, fitImg);
        const proj = projectHomography(H, obj_pts);
        const inb: number[] = [];
        for (let j = 0; j < proj.length; j++) {
          const p = proj[j]!;
          if (p.x >= 0 && p.x <= cols - 1 && p.y >= 0 && p.y <= rows - 1)
            inb.push(j);
        }
        // findHomography needs >= 4 correspondences; fewer usable points
        // means the marker is leaving the frame — keep the current fit.
        if (inb.length < 4) break;
        const refined = await cornerSubPix(
          blurred,
          inb.map((j) => proj[j]!),
        );
        img_pts = proj.slice();
        inb.forEach((j, k) => (img_pts[j] = refined[k]!));
        fitObj = inb.map((j) => obj_pts[j]!);
        fitImg = refined;
      }
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
      if (target === null && d.id === this.targetId) {
        // A refinement failure must DEGRADE, not kill the tracker loop —
        // pre-fix, one cv assertion rejected `this.task` and the tracker
        // silently died for the rest of the session (rig crash 2026-07-11).
        // Treat it as a lost tick; surface the first failure per tracker.
        try {
          target = await this.fitSubPix(detections.frame, d);
        } catch (e) {
          if (!this.fitFailed) {
            this.fitFailed = true;
            report(
              "marker-tracker",
              `subpix refinement failed (degrading to detection corners): ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }
      } else others.push(d);
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
    // Named meter (calibration review 2026-07-11, Lane F handoff): the native
    // detector thread meters under the detect NODE id, so the session-
    // registered graph rows stop rendering unmetered.
    const stream = this.detector.stream(this.camera.stream, this.scale, this.meterName);
    this.stream = stream;
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
    this.stream = null; // probe reads null from here (native weak capture)
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

export interface ServoOptions {
  kp?: number;
  originLeft?: () => Point2d;
  originRight?: () => Point2d;
  /** Composing window/session id for the servo's graph nodes (`win/<owner>/...`).
   *  Callers pass their session id (e.g. `calibrate-drift`); those that don't get
   *  a generic default. */
  owner?: string;
}

export interface Servo {
  stop(): void;
  /** The per-eye graph-visible PID controller nodes (null for an eye with no
   *  tracker). Each node's override slot is driven by the module's `pidOverride`
   *  contract command (`applyPidOverride(servo.override.<eye>, cmd)`). */
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
 * (docs/proposals/pid-nodes-and-view-replumb.md) that push a combined pose to
 * the shared controller NODE (controller-node-and-fifo-edges §3). The device
 * transport (v2 CMD_STREAM / v1 awaited actuate + enable lifecycle) lives in the
 * node; this function no longer runs its own actuate loop or touches
 * `activeController` — it opens ONE position input and pushes on each detection.
 *
 * CONTROL CORE. The original hand-rolled `pos += rel*kp` is a VELOCITY-FORM
 * update: the running command is `previous + gain·error`. Mapped onto the
 * uniform {@link PidParams} that is `ki = kp` with `kp = kd = 0` — the parallel
 * PID output then collapses to its (unbounded, as the original never clamped)
 * integrator, so `PID2D.step(rel)` returns `base + kp·rel` exactly (see
 * @lib/pid). Each eye owns a `PID2D` (independent x/y integrators, exactly the
 * original's component-wise `{x,y}` update); dt is 1 per detection tick. The
 * integrator is RE-BASED each tick on the last APPLIED volts — `update()`'s
 * synchronous return (`predictVolts`), SEEDED from the controller's live `pos`
 * on the first tick. This is bit-identical to the original read of
 * `c.pos.left/right` (A-30: `predictVolts` equals the actuate readback) AND
 * correct on the streaming path, where `c.pos` is static because updates never
 * round-trip. The default `kp` (16.0) and the per-caller value (calibrate-drift
 * passes 10.0) carry through unchanged as `ki`.
 *
 * OVERRIDE. Each eye's PID node exposes a RULED override slot
 * (`servo.override.left`/`right`); the owning module drives it from its
 * `pidOverride` contract command via `applyPidOverride` (a pose engages/updates,
 * a release resumes). While engaged, `node.step` skips the control law and
 * resets that eye's integrator each tick (no windup builds behind the drag); the
 * output is the pinned pose. On release the node's `seed` reseeds the integrator
 * from the LAST override so control resumes FROM the released pose — velocity-
 * form continuity, no snap-back (the behavioral guarantee the ruled slot adds;
 * the re-base already resumes from the dragged `c.pos`, and the seed keeps that
 * true even if a future migration makes the integrator authoritative). The per-
 * eye grain is preserved because each eye is a separate node: dragging ONE eye
 * pins it while the other keeps servoing — a single all-or-nothing slot could
 * not.
 */
export function startServo(
  left: MarkerTracker | undefined,
  right: MarkerTracker | undefined,
  opts: ServoOptions = {},
): Servo {
  const { kp = 16.0 } = opts;
  const owner = opts.owner ?? "marker-servo";
  const node = controllerNode();
  const disposers: Array<() => void> = [];

  // The pose the node holds. `applied` = last APPLIED volts (re-base source),
  // seeded once from the controller's live `pos`; `pending` = the pose pushed on
  // each detection (the non-firing eye holds its last applied value — physically
  // identical to the original's per-eye `_pos` hold). A single MCU stream drives
  // both eyes, so the push is always a full pair.
  const applied: PositionPair = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  const pending: PositionPair = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  let seeded = false;
  const input = node.openPosition("servo", {
    // `from` omitted: the per-eye PID nodes already draw `…/pid/<side> →
    // controller` edges, so the input registers no additional edge.
    initial: { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
  });

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
      outputs: [{ to: nodeId.controller(), port: side }],
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

  /** Seed the re-base source from the controller's live position ONCE, so the
   *  first tick starts from the real mirror pose (as the original read of
   *  `c.pos` did). After this, `applied` tracks `update()`'s predicted return. */
  function ensureSeeded(pos: { left: Pos; right: Pos }): void {
    if (seeded) return;
    seeded = true;
    applied.left = { ...pos.left };
    applied.right = { ...pos.right };
  }

  function onDetection(
    side: "left" | "right",
    tracker: MarkerTracker,
    pid: PID2D,
    pidNode: PidNodeHandle<Pos>,
    originThunk: (() => Point2d) | undefined,
  ): void {
    const c = node.liveController;
    if (!c) return;
    ensureSeeded(c.pos);
    const base = side === "left" ? applied.left : applied.right;
    const origin = originThunk?.() ?? { x: 0, y: 0 };
    // The node's override slot is driven externally (the module's `pidOverride`
    // command → `applyPidOverride(pidNode.override, …)`). `pidNode.step` runs
    // `control` UNLESS the slot is engaged — then it resets `pid` and returns the
    // pinned pose (the old `override ?? servo` poll, at the node).
    pending[side] = outputOf(pidNode.step(() => control(base, tracker.centerRelative, origin, pid)));
    // Push the combined pose; the return is the applied (predicted) volts — the
    // next tick's re-base for BOTH eyes (the held eye keeps its last value).
    const predicted = input.update({ left: pending.left, right: pending.right });
    applied.left = predicted.left;
    applied.right = predicted.right;
    pending.left = predicted.left;
    pending.right = predicted.right;
  }

  if (left && pidLeft && nodeLeft)
    disposers.push(
      left.onDetection(() => onDetection("left", left, pidLeft, nodeLeft, opts.originLeft)),
    );
  if (right && pidRight && nodeRight)
    disposers.push(
      right.onDetection(() => onDetection("right", right, pidRight, nodeRight, opts.originRight)),
    );

  return {
    nodes: { left: nodeLeft, right: nodeRight },
    override: {
      left: nodeLeft?.override ?? null,
      right: nodeRight?.override ?? null,
    },
    stop() {
      for (const d of disposers) d();
      nodeLeft?.dispose();
      nodeRight?.dispose();
      // Terminate the MCU stream + disable the controller iff the node enabled it
      // (fire-and-forget, matching the original's un-awaited disable).
      void input.close();
    },
  };
}
