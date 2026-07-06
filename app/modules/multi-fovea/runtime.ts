// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { Point2d, Rect, Size } from "core/Geometry";
import type { Mat } from "core/Vision";
import type { StreamHandle } from "@orchestrator/controller";
import type { RoundRobinFrameScheduler } from "@orchestrator/scheduler";
import { RECT } from "@lib/util/geometry";
import type {
  MultiFoveaTargetConfig,
  MultiFoveaTargetTelemetry,
} from "./contract";

export interface TrackerLike {
  init(frame: Mat<Uint8Array>, roi: Rect): void;
  updateAsync(frame: Mat<Uint8Array>): Promise<Rect | null>;
  release(): void;
}

export interface MultiFoveaRuntimeDeps {
  createTracker(): TrackerLike;
  createStream(index: number, center: Point2d): Promise<StreamHandle | null>;
  targetPose(index: number, center: Point2d): {
    angle: Point2d;
    volt: MultiFoveaTargetTelemetry["volt"];
  };
  updateScheduler(targets: Array<{ stream: number }>): void;
  publish(targets: MultiFoveaTargetTelemetry[]): void;
}

type Slot = {
  config: MultiFoveaTargetConfig;
  tracker: TrackerLike | null;
  stream: StreamHandle | null;
  active: boolean;
  bbox: Rect | null;
  steering: Point2d | null;
  angle: Point2d;
  volt: MultiFoveaTargetTelemetry["volt"];
  lostCount: number;
  lastFinAt: number | null;
};

const ORIGIN = { x: 0, y: 0 };

export class MultiFoveaRuntime {
  private slots: Slot[] = [];
  private size: Size = { width: 0, height: 0 };
  private streamSyncing = false;
  private streamSyncDirty = false;
  private generation = 0;
  private updating = false;

  constructor(
    private readonly scheduler: Pick<RoundRobinFrameScheduler, "activeRequestCount">,
    private readonly deps: MultiFoveaRuntimeDeps,
  ) {}

  setTargets(configs: MultiFoveaTargetConfig[]): void {
    this.generation++;
    const next = configs.map((config, index) => {
      const existing = this.slots[index];
      if (existing) {
        const changed = !sameTargetConfig(existing.config, config);
        existing.config = config;
        if (!config.enabled || changed) this.releaseSlot(existing);
        existing.steering = null;
        const pose = this.deps.targetPose(index, config.center);
        existing.angle = pose.angle;
        existing.volt = pose.volt;
        return existing;
      }
      const pose = this.deps.targetPose(index, config.center);
      return {
        config,
        tracker: null,
        stream: null,
        active: false,
        bbox: null,
        steering: null,
        angle: pose.angle,
        volt: pose.volt,
        lostCount: 0,
        lastFinAt: null,
      };
    });
    for (const slot of this.slots.slice(configs.length)) this.releaseSlot(slot);
    this.slots = next;
    this.requestStreamSync();
    this.publish();
  }

  steerTarget(index: number, center: Point2d): void {
    const slot = this.slots[index];
    if (!slot?.config.enabled) return;
    slot.tracker?.release();
    slot.tracker = null;
    slot.active = false;
    slot.steering = center;
    slot.bbox = this.clampRect(
      RECT.fromCenter(center, {
        width: slot.config.tracker.width,
        height: slot.config.tracker.height,
      }),
    );
    const pose = this.deps.targetPose(index, center);
    slot.angle = pose.angle;
    slot.volt = pose.volt;
    slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
    this.publish();
  }

  dispose(): void {
    this.generation++;
    for (const slot of this.slots) this.releaseSlot(slot);
    this.slots = [];
    this.deps.updateScheduler([]);
  }

  onFrameFinished(stream: number, now = performance.now()): void {
    const slot = this.slots.find((s) => s.stream?.id === stream);
    if (!slot) return;
    slot.lastFinAt = now;
    this.publish(now);
  }

  async onCenterFrame(frame: Mat<Uint8Array>): Promise<number> {
    if (this.updating) return 0;
    this.updating = true;
    const generation = this.generation;
    const [height, width] = frame.shape;
    this.size = { width, height };
    const t0 = performance.now();
    try {
      await Promise.all(
        this.slots.map((slot, index) =>
          this.updateSlot(index, slot, frame, generation),
        ),
      );
      if (generation === this.generation) this.publish();
      return performance.now() - t0;
    } finally {
      this.updating = false;
    }
  }

  private async updateSlot(
    index: number,
    slot: Slot,
    frame: Mat<Uint8Array>,
    generation: number,
  ): Promise<void> {
    if (!slot.config.enabled) return;
    if (slot.steering) {
      const pose = this.deps.targetPose(index, slot.steering);
      slot.angle = pose.angle;
      slot.volt = pose.volt;
      slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
      return;
    }
    if (!slot.tracker) {
      const roi = this.clampRect(
        RECT.fromCenter(slot.config.center, {
          width: slot.config.tracker.width,
          height: slot.config.tracker.height,
        }),
      );
      slot.tracker = this.deps.createTracker();
      slot.tracker.init(frame, roi);
      slot.bbox = roi;
      slot.active = true;
      slot.lostCount = 0;
    } else {
      const bbox = await slot.tracker.updateAsync(frame);
      if (generation !== this.generation || slot.steering) return;
      if (bbox) {
        slot.bbox = this.clampRect(bbox);
        slot.lostCount = 0;
      } else if (++slot.lostCount >= slot.config.tracker.lostTolerance) {
        this.releaseSlot(slot);
        return;
      }
    }

    const center = slot.bbox ? RECT.getCenter(slot.bbox) : slot.config.center;
    const pose = this.deps.targetPose(index, center);
    slot.angle = pose.angle;
    slot.volt = pose.volt;
    slot.stream?.update({ left: pose.volt.L, right: pose.volt.R });
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
            this.releaseSlot(slot);
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

  private releaseSlot(slot: Slot): void {
    slot.tracker?.release();
    slot.tracker = null;
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

function sameTargetConfig(
  a: MultiFoveaTargetConfig,
  b: MultiFoveaTargetConfig,
): boolean {
  return (
    a.enabled === b.enabled &&
    a.center.x === b.center.x &&
    a.center.y === b.center.y &&
    a.tracker.width === b.tracker.width &&
    a.tracker.height === b.tracker.height &&
    a.tracker.padX === b.tracker.padX &&
    a.tracker.padY === b.tracker.padY &&
    a.tracker.lostTolerance === b.tracker.lostTolerance
  );
}
