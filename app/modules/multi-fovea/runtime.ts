// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea target runtime (C-24 step 4). Tracking runs on B-25's native
// multi-KCF thread (`createMultiTracker` — one thread, batched per-frame
// results, fused undistort); this runtime is the SESSION-SIDE POLICY half:
// slot bookkeeping, arm/disarm churn (slot index = tracker target id),
// lost-tolerance (the thread emits `ok:false` liberally — tolerance absorbs
// it, per the B-25 ruling), steering, pose math via deps, controller-stream
// sync, and telemetry. The old per-slot JS KCF (busy-drop + generation
// staleness guards) is GONE — staleness is intrinsic to the native thread.

import type { Point2d, Rect, Size } from "core/Geometry";
import type { StreamHandle } from "@orchestrator/controller";
import type { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import { RECT } from "@lib/util/geometry";
import type {
  MultiFoveaTargetConfig,
  MultiFoveaTargetTelemetry,
} from "./contract";

/** One per-frame batch from the native multi-KCF thread (B-25 ruled shape). */
export type MultiTrackBatch = {
  seq: number;
  deviceTimestamp?: bigint;
  targets: Array<{ id: string; ok: boolean; bbox: Rect | null; updateMs: number }>;
};

export interface MultiFoveaRuntimeDeps {
  /** (Re-)arm the native tracker target — `arm()` on a LIVE id RE-INITS it
   *  (the ruled steer-while-armed path; the learned filter resets, inherent). */
  arm(id: string, roi: Rect): void;
  disarm(id: string): void;
  createStream(index: number, center: Point2d): Promise<StreamHandle | null>;
  targetPose(index: number, center: Point2d): {
    angle: Point2d;
    volt: MultiFoveaTargetTelemetry["volt"];
  };
  updateScheduler(targets: Array<{ stream: number }>): void;
  publish(targets: MultiFoveaTargetTelemetry[]): void;
  /** Project a mirror ANGLE (rad) to a wide-camera pixel — used to place a
   *  fixed-angle PRESET target's fovea crop. null (no arg / uncalibrated) →
   *  the caller falls back to the slot's `center`. */
  projectAngle?(angle: Point2d): Point2d | null;
  /** Steer the slot's composed fovea crop node (C-24: `setFoveaRect` on the
   *  `camera/<serial>/undistort/fovea/<index>` pipe — a no-op when the window
   *  hasn't composed that node). */
  updateFoveaRect(index: number, rect: Rect): void;
}

type Slot = {
  config: MultiFoveaTargetConfig;
  armed: boolean;
  stream: StreamHandle | null;
  active: boolean;
  bbox: Rect | null;
  steering: Point2d | null;
  angle: Point2d;
  volt: MultiFoveaTargetTelemetry["volt"];
  lostCount: number;
  lastFinAt: number | null;
};

export class MultiFoveaRuntime {
  private slots: Slot[] = [];
  private size: Size = { width: 0, height: 0 };
  private streamSyncing = false;
  private streamSyncDirty = false;
  private generation = 0;

  constructor(
    private readonly scheduler: Pick<RoundRobinFrameScheduler, "activeRequestCount">,
    private readonly deps: MultiFoveaRuntimeDeps,
  ) {}

  /** Camera frame dims (the arm-rect clamp source — ruled: from the lease at
   *  activate, not learned per frame). Call BEFORE the first `setTargets`. */
  setFrameSize(size: Size): void {
    this.size = size;
  }

  setTargets(configs: MultiFoveaTargetConfig[]): void {
    this.generation++;
    const next = configs.map((config, index) => {
      const existing = this.slots[index];
      if (existing) {
        const changed = !sameTargetConfig(existing.config, config);
        existing.config = config;
        existing.steering = null;
        if (!config.enabled) this.releaseSlot(existing, index);
        else if (config.preset) this.positionPreset(existing, index);
        else if (changed || !existing.armed) this.armSlot(existing, index);
        const pose = this.deps.targetPose(index, config.center);
        existing.angle = pose.angle;
        existing.volt = pose.volt;
        return existing;
      }
      const pose = this.deps.targetPose(index, config.center);
      const slot: Slot = {
        config,
        armed: false,
        stream: null,
        active: false,
        bbox: null,
        steering: null,
        angle: pose.angle,
        volt: pose.volt,
        lostCount: 0,
        lastFinAt: null,
      };
      if (config.enabled) {
        if (config.preset) this.positionPreset(slot, index);
        else this.armSlot(slot, index);
      }
      return slot;
    });
    for (const [i, slot] of this.slots.slice(configs.length).entries())
      this.releaseSlot(slot, configs.length + i);
    this.slots = next;
    this.requestStreamSync();
    this.publish();
  }

  /** Manual hold: disarm tracking and follow the steered point (until the
   *  target is re-placed — `placeTarget` → `setTargets` → re-arm). */
  steerTarget(index: number, center: Point2d): void {
    const slot = this.slots[index];
    if (!slot?.config.enabled) return;
    if (slot.armed) this.deps.disarm(String(index));
    slot.armed = false;
    slot.active = false;
    slot.steering = center;
    slot.bbox = this.clampRect(
      RECT.fromCenter(center, {
        width: slot.config.tracker.width,
        height: slot.config.tracker.height,
      }),
    );
    this.deps.updateFoveaRect(index, slot.bbox);
    const pose = this.deps.targetPose(index, center);
    slot.angle = pose.angle;
    slot.volt = pose.volt;
    slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
    this.publish();
  }

  dispose(): void {
    this.generation++;
    for (const [index, slot] of this.slots.entries()) this.releaseSlot(slot, index);
    this.slots = [];
    this.deps.updateScheduler([]);
  }

  onFrameFinished(stream: number, now = performance.now()): void {
    const slot = this.slots.find((s) => s.stream?.id === stream);
    if (!slot) return;
    slot.lastFinAt = now;
    this.publish(now);
  }

  /** Consume one native batch (B-25). Returns the thread's summed per-target
   *  update cost (ms) for the session's trackMs telemetry. */
  onTrackResults(batch: MultiTrackBatch): number {
    let trackMs = 0;
    let dirty = false;
    for (const t of batch.targets) {
      trackMs += t.updateMs;
      const index = Number(t.id);
      const slot = this.slots[index];
      if (!slot || !slot.armed || slot.steering) continue; // stale/disarmed id
      dirty = true;
      if (t.ok && t.bbox) {
        slot.bbox = this.clampRect(t.bbox);
        slot.active = true;
        slot.lostCount = 0;
      } else if (++slot.lostCount >= slot.config.tracker.lostTolerance) {
        this.releaseSlot(slot, index);
        continue;
      }
      const center = slot.bbox ? RECT.getCenter(slot.bbox) : slot.config.center;
      const pose = this.deps.targetPose(index, center);
      slot.angle = pose.angle;
      slot.volt = pose.volt;
      slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
      if (slot.bbox) this.deps.updateFoveaRect(index, slot.bbox);
    }
    if (dirty) this.publish();
    return trackMs;
  }

  /** (Re-)arm the native target at the slot's configured center — arm on a
   *  live id re-inits natively (ruled steer-while-armed path). */
  private armSlot(slot: Slot, index: number): void {
    const roi = this.clampRect(
      RECT.fromCenter(slot.config.center, {
        width: slot.config.tracker.width,
        height: slot.config.tracker.height,
      }),
    );
    this.deps.arm(String(index), roi);
    slot.armed = true;
    slot.active = true;
    slot.bbox = roi;
    slot.lostCount = 0;
    this.deps.updateFoveaRect(index, roi);
  }

  /** Position a fixed mirror-angle PRESET target (the demo's angle-space path):
   *  NO KCF (`armed` stays false → excluded from `onTrackResults`); the pose is
   *  the preset angle via `targetPose`, the fovea crop is centered on the
   *  projected wide-camera pixel (falls back to the slot's `center` when
   *  uncalibrated), and the controller stream is nudged to the preset volts.
   *  The round-robin still interleaves it exactly like a KCF target — it just
   *  never moves. */
  private positionPreset(slot: Slot, index: number): void {
    const pose = this.deps.targetPose(index, slot.config.center);
    slot.armed = false;
    slot.active = true;
    slot.steering = null;
    slot.angle = pose.angle;
    slot.volt = pose.volt;
    const px = this.deps.projectAngle?.(pose.angle) ?? slot.config.center;
    slot.bbox = this.clampRect(
      RECT.fromCenter(px, {
        width: slot.config.tracker.width,
        height: slot.config.tracker.height,
      }),
    );
    slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
    this.deps.updateFoveaRect(index, slot.bbox);
  }

  private requestStreamSync(): void {
    if (this.streamSyncing) {
      this.streamSyncDirty = true;
      return;
    }
    void this.syncStreams();
  }

  private async syncStreams(): Promise<void> {
    this.streamSyncing = true;
    try {
      do {
        this.streamSyncDirty = false;
        const generation = this.generation;
        let stale = false;
        for (let index = 0; index < this.slots.length; index++) {
          const slot = this.slots[index];
          if (!slot.config.enabled) {
            this.releaseSlot(slot, index);
            continue;
          }
          if (slot.stream) continue;

          const stream = await this.deps.createStream(index, slot.config.center);
          if (!stream) continue;
          if (
            generation !== this.generation ||
            this.slots[index] !== slot ||
            !slot.config.enabled
          ) {
            await stream.close();
            stale = true;
            break;
          }
          slot.stream = stream;
        }
        if (!stale && generation === this.generation)
          this.deps.updateScheduler(
            this.slots
              .filter((slot) => slot.config.enabled && slot.stream)
              .map((slot) => ({ stream: slot.stream!.id })),
          );
      } while (this.streamSyncDirty);
    } finally {
      this.streamSyncing = false;
      if (this.streamSyncDirty) this.requestStreamSync();
    }
  }

  private releaseSlot(slot: Slot, index: number): void {
    if (slot.armed) this.deps.disarm(String(index));
    slot.armed = false;
    void slot.stream?.close();
    slot.stream = null;
    slot.active = false;
    slot.bbox = null;
    slot.steering = null;
  }

  private clampRect(r: Rect): Rect {
    const x = Math.max(0, Math.min(Math.round(r.x), this.size.width - 1));
    const y = Math.max(0, Math.min(Math.round(r.y), this.size.height - 1));
    const width = Math.max(1, Math.min(Math.round(r.width), this.size.width - x));
    const height = Math.max(1, Math.min(Math.round(r.height), this.size.height - y));
    return { x, y, width, height };
  }

  private publish(now = performance.now()): void {
    this.deps.publish(
      this.slots.map((slot, index) => ({
        index,
        enabled: slot.config.enabled,
        active: slot.active,
        bbox: slot.bbox,
        angle: slot.angle,
        volt: slot.volt,
        streamId: slot.stream?.id ?? null,
        streamHz: 0,
        lastFinAgeMs: slot.lastFinAt === null ? null : now - slot.lastFinAt,
        lostCount: slot.lostCount,
      })),
    );
  }
}

function samePreset(
  a: MultiFoveaTargetConfig["preset"],
  b: MultiFoveaTargetConfig["preset"],
): boolean {
  if (!a || !b) return !a && !b;
  return a.pan === b.pan && a.tilt === b.tilt;
}

function sameTargetConfig(
  a: MultiFoveaTargetConfig,
  b: MultiFoveaTargetConfig,
): boolean {
  return (
    a.enabled === b.enabled &&
    samePreset(a.preset, b.preset) &&
    a.center.x === b.center.x &&
    a.center.y === b.center.y &&
    a.tracker.width === b.tracker.width &&
    a.tracker.height === b.tracker.height &&
    a.tracker.padX === b.tracker.padX &&
    a.tracker.padY === b.tracker.padY &&
    a.tracker.lostTolerance === b.tracker.lostTolerance
  );
}
