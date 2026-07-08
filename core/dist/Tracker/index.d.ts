// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject } from "../types";
import type { Mat } from "core/Vision";
import type { Rect } from "core/Geometry";
import type { Camera } from "core/Aravis";

declare module "core/Tracker" {
  export class KCF extends CoreObject<KCF> {
    constructor();
    init(frame: Mat, roi: Rect): void;
    update(frame: Mat): Rect | null;
    updateAsync(frame: Mat): Promise<Rect | null>;
  }

  /** One KCF result off the 1d tracker thread (WS1 1d). */
  export interface TrackResult {
    found: boolean;
    /** Tracked box in frame pixels, or null when tracking is lost. */
    bbox: Rect | null;
    /** Monotonic result counter (produced by the tracker thread). */
    seq: number;
    /** Source frame's camera-clock timestamp — correlate with recorder/pipe. */
    deviceTimestamp: bigint;
  }

  /** One stream's probed view (mirror of the native `Meter::StreamStat`). */
  export interface WorkloadStat {
    count: number;
    ratePerSec: number;
    maxIntervalMs: number;
  }

  /** Out-of-loop probe of the tracker thread's native `ThreadMeter` — same
   *  shape the pipe producer reports, so it splices into `perfSnapshot.workloads`. */
  export interface TrackerMeter {
    name: string;
    uptimeMs: number;
    utilization: number;
    busyMs: number;
    dropTotal: number;
    inputs: Record<string, WorkloadStat>;
    outputs: Record<string, WorkloadStat>;
  }

  /** KCF tracker running on its OWN free-running C++ thread (WS1 1d): it
   *  consumes the LATEST frame off the camera's shared `Arv::Stream`
   *  (latest-wins, drop-stale) and runs full-frame KCF off the JS loop; results
   *  arrive via async iteration. `arm(roi)` (re-)inits KCF on the next frame. */
  export interface Tracker extends CoreObject<Tracker>, AsyncIterable<TrackResult> {
    arm(roi: Rect): void;
    /** Snapshot the native meter (safe from the orchestrator thread). */
    probe(): TrackerMeter;
    /** Test-only: add `ms` of artificial per-frame work (drives the drop path). */
    stall(ms: number): void;
  }

  /** Create a KCF tracker thread bound to `camera`'s shared stream (WS1 1d). */
  export function createTracker(camera: Camera): Tracker;
}
