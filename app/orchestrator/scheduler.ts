// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Round-robin CMD_FRAME scheduler for protocol-v2 streams. This is deliberately
// pure host-side logic over Controller.frame(): it knows nothing about cameras,
// calibration, or renderer state, so the synced-capture and multi-fovea layers
// can share it once hardware capture is enabled.

import type { CameraName } from "core/Controller";
import type { FrameOutcome } from "./controller.js";

export const FRAME_QUEUE_CAPACITY = 8;

export type FrameRequest = {
  stream: number;
  cameras?: CameraName[] | number;
  pulse?: number;
};

export type ScheduledFrameTarget = FrameRequest & {
  enabled?: boolean;
  minIntervalMs?: number;
};

export type FrameRequestPromise = Promise<FrameOutcome> & {
  accepted: Promise<unknown>;
};

export interface FrameRequester {
  frame(request: FrameRequest): FrameRequestPromise;
}

export type ScheduledFrameFailure = {
  target: ScheduledFrameTarget;
  error: unknown;
};

export interface FrameSchedulerOptions {
  requester: FrameRequester;
  targets?: ScheduledFrameTarget[];
  maxInFlight?: number;
  defaultMinIntervalMs?: number;
  retryDelayMs?: number;
  acceptedTimeoutMs?: number;
  completionTimeoutMs?: number;
  now?: () => number;
  isDuplicateRejection?: (error: unknown) => boolean;
  onAccepted?: (target: ScheduledFrameTarget) => void;
  onFrame?: (frame: FrameOutcome, target: ScheduledFrameTarget) => void;
  onReject?: (failure: ScheduledFrameFailure) => void;
  onTimeout?: (failure: ScheduledFrameFailure) => void;
  onError?: (failure: ScheduledFrameFailure) => void;
}

function defaultDuplicateRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("duplicate") ||
    lower.includes("already pending") ||
    lower.includes("pending frame")
  );
}

export class RoundRobinFrameScheduler {
  private targets: ScheduledFrameTarget[];
  private cursor = 0;
  private running = false;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly activeStreams = new Set<number>();
  private readonly nextEligibleAt = new Map<number, number>();
  private readonly maxInFlight: number;
  private readonly defaultMinIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly acceptedTimeoutMs: number;
  private readonly completionTimeoutMs: number;
  private readonly now: () => number;
  private readonly isDuplicateRejection: (error: unknown) => boolean;

  constructor(private readonly opts: FrameSchedulerOptions) {
    this.targets = [...(opts.targets ?? [])];
    this.maxInFlight = Math.max(
      1,
      Math.min(opts.maxInFlight ?? FRAME_QUEUE_CAPACITY, FRAME_QUEUE_CAPACITY),
    );
    this.defaultMinIntervalMs = opts.defaultMinIntervalMs ?? 0;
    this.retryDelayMs = opts.retryDelayMs ?? this.defaultMinIntervalMs;
    this.acceptedTimeoutMs = opts.acceptedTimeoutMs ?? 100;
    this.completionTimeoutMs = opts.completionTimeoutMs ?? 1000;
    this.now = opts.now ?? (() => performance.now());
    this.isDuplicateRejection =
      opts.isDuplicateRejection ?? defaultDuplicateRejection;
  }

  get activeRequestCount(): number {
    return this.inFlight;
  }

  setTargets(targets: ScheduledFrameTarget[]): void {
    this.targets = [...targets];
    if (this.cursor >= this.targets.length) this.cursor = 0;
    const live = new Set(this.targets.map((t) => t.stream));
    for (const stream of this.nextEligibleAt.keys())
      if (!live.has(stream)) this.nextEligibleAt.delete(stream);
    this.pump();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  pump(): void {
    if (!this.running) return;
    this.clearTimer();
    while (this.inFlight < this.maxInFlight) {
      const target = this.nextTarget();
      if (!target) break;
      this.issue(target);
    }
    this.armNextTimer();
  }

  private nextTarget(): ScheduledFrameTarget | null {
    const n = this.targets.length;
    if (n === 0) return null;
    const now = this.now();
    for (let offset = 0; offset < n; offset++) {
      const index = (this.cursor + offset) % n;
      const target = this.targets[index];
      if (target.enabled === false) continue;
      if (this.activeStreams.has(target.stream)) continue;
      if ((this.nextEligibleAt.get(target.stream) ?? 0) > now) continue;
      this.cursor = (index + 1) % n;
      return target;
    }
    return null;
  }

  private issue(target: ScheduledFrameTarget): void {
    const request = {
      stream: target.stream,
      cameras: target.cameras,
      pulse: target.pulse,
    };
    const minIntervalMs = target.minIntervalMs ?? this.defaultMinIntervalMs;
    const launchedAt = this.now();
    this.nextEligibleAt.set(target.stream, launchedAt + minIntervalMs);
    this.inFlight++;
    this.activeStreams.add(target.stream);

    let done = false;
    const acceptedTimer = this.armTimeout(this.acceptedTimeoutMs, () =>
      finish("timeout", new Error("Frame request ACK timed out")),
    );
    const completionTimer = this.armTimeout(this.completionTimeoutMs, () =>
      finish("timeout", new Error("Frame request FIN timed out")),
    );

    const retryLater = () => {
      const retryAt = this.now() + this.retryDelayMs;
      this.nextEligibleAt.set(
        target.stream,
        Math.max(this.nextEligibleAt.get(target.stream) ?? 0, retryAt),
      );
    };

    const finish = (
      status: "frame" | "reject" | "timeout",
      value: FrameOutcome | unknown,
    ) => {
      if (done) return;
      done = true;
      this.clearTimeout(acceptedTimer);
      this.clearTimeout(completionTimer);
      this.inFlight--;
      this.activeStreams.delete(target.stream);

      if (status === "frame") {
        this.opts.onFrame?.(value as FrameOutcome, target);
      } else {
        retryLater();
        const failure = { target, error: value };
        if (status === "timeout") this.opts.onTimeout?.(failure);
        else {
          this.opts.onReject?.(failure);
          if (!this.isDuplicateRejection(value)) this.opts.onError?.(failure);
        }
      }
      this.pump();
    };

    try {
      const frame = this.opts.requester.frame(request);
      frame.accepted.then(
        () => {
          this.clearTimeout(acceptedTimer);
          if (!done) this.opts.onAccepted?.(target);
        },
        (error) => finish("reject", error),
      );
      frame.then(
        (result) => finish("frame", result),
        (error) => finish("reject", error),
      );
    } catch (error) {
      finish("reject", error);
    }
  }

  private armNextTimer(): void {
    if (!this.running || this.inFlight >= this.maxInFlight) return;
    let nextAt = Infinity;
    for (const target of this.targets) {
      if (target.enabled === false || this.activeStreams.has(target.stream))
        continue;
      nextAt = Math.min(nextAt, this.nextEligibleAt.get(target.stream) ?? 0);
    }
    if (nextAt === Infinity) return;
    this.timer = setTimeout(() => this.pump(), Math.max(0, nextAt - this.now()));
  }

  private armTimeout(ms: number, fn: () => void): ReturnType<typeof setTimeout> | null {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return setTimeout(fn, ms);
  }

  private clearTimer(): void {
    this.clearTimeout(this.timer);
    this.timer = null;
  }

  private clearTimeout(timer: ReturnType<typeof setTimeout> | null): void {
    if (timer) clearTimeout(timer);
  }
}
