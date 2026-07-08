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

function backToCenter(p: number, kp: number): number {
  return -clamp(Math.sign(p) * kp, [Math.min(0, p), Math.max(0, p)]);
}

export interface ServoOptions {
  kp?: number;
  originLeft?: () => Point2d;
  originRight?: () => Point2d;
  /** Manual override, checked every tick — takes priority over the
   *  tracker-driven command (matches the original's drag-to-override). */
  overrideLeft?: () => Pos | null;
  overrideRight?: () => Pos | null;
}

export interface Servo {
  stop(): void;
}

/**
 * Visual-servo the controller toward `left`/`right` trackers' targets (or
 * back toward `origin*` when no target is visible) — port of the original
 * `actuate()`. Runs against the orchestrator's shared `activeController()`
 * (same holder tracking-single/manual-control's `startActuationLoop` reads),
 * not a passed-in facade — the caller doesn't own enable/disable bracketing
 * beyond calling `stop()`.
 */
export function startServo(
  left: MarkerTracker | undefined,
  right: MarkerTracker | undefined,
  opts: ServoOptions = {},
): Servo {
  const { kp = 16.0 } = opts;
  const pending: { left?: Pos; right?: Pos } = {};
  const disposers: Array<() => void> = [];
  let running = true;
  let enabledByUs = false;

  function onLeftDetection(): void {
    const c = activeController();
    if (!c) return;
    const rel = left!.centerRelative;
    const { x, y } = c.pos.left;
    if (rel) {
      pending.left = { x: x + rel.x * kp, y: y + rel.y * kp };
    } else {
      const origin = opts.originLeft?.() ?? { x: 0, y: 0 };
      pending.left = { x: x + backToCenter(x - origin.x, kp), y: y + backToCenter(y - origin.y, kp) };
    }
  }
  function onRightDetection(): void {
    const c = activeController();
    if (!c) return;
    const rel = right!.centerRelative;
    const { x, y } = c.pos.right;
    if (rel) {
      pending.right = { x: x + rel.x * kp, y: y + rel.y * kp };
    } else {
      const origin = opts.originRight?.() ?? { x: 0, y: 0 };
      pending.right = { x: x + backToCenter(x - origin.x, kp), y: y + backToCenter(y - origin.y, kp) };
    }
  }
  if (left) disposers.push(left.onDetection(onLeftDetection));
  if (right) disposers.push(right.onDetection(onRightDetection));

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
          const left_ = opts.overrideLeft?.() ?? pending.left;
          const right_ = opts.overrideRight?.() ?? pending.right;
          await c.actuate({ left: left_, right: right_ });
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
    stop() {
      running = false;
      for (const d of disposers) d();
      if (enabledByUs) {
        activeController()?.disable();
        enabledByUs = false;
      }
    },
  };
}
