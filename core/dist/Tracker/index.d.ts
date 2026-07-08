// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject } from "../types";
import type { CameraCalibration, Mat } from "core/Vision";
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
  export interface KcfTracker extends CoreObject<KcfTracker>, AsyncIterable<TrackResult> {
    arm(roi: Rect): void;
    /** Snapshot the native meter (safe from the orchestrator thread). */
    probe(): TrackerMeter;
    /** Test-only: add `ms` of artificial per-frame work (drives the drop path). */
    stall(ms: number): void;
  }

  /** Create a KCF tracker thread bound to `camera`'s shared stream (WS1 1d).
   *  Optional `name` = the graph node id (becomes the meter/probe name;
   *  defaults to the legacy `"tracker:center"`). */
  export function createTracker(camera: Camera, name?: string): KcfTracker;

  /** One target's verdict inside a `MultiTrackResult` batch (real-2, B-25). */
  export interface MultiTrackTarget {
    /** Opaque target id, as passed to `arm()` (multi-fovea slot ids). */
    id: string;
    /** False = lost this frame (incl. a degenerate/edge-drifted patch). Lost
     *  POLICY (lostTolerance/auto-disarm) is the app's — native never
     *  auto-disarms. */
    ok: boolean;
    /** Tracked box, or null when `ok` is false. UNDISTORTED-frame pixels when
     *  the tracker was created with `cal`; raw-frame pixels otherwise. On the
     *  (re-)arm frame this echoes the armed roi (frame-bound clamped). */
    bbox: Rect | null;
    /** This target's KCF init/update cost on the shared thread (ms). */
    updateMs: number;
  }

  /** One per-frame batch off the multi-KCF thread: ALL armed targets tracked
   *  on the SAME frame (per-frame coherent). Emitted EVERY frame while ≥1
   *  target is armed. */
  export interface MultiTrackResult {
    /** Monotonic batch counter (produced by the tracker thread). */
    seq: number;
    /** Source frame's camera-clock timestamp — correlate with recorder/pipe. */
    deviceTimestamp: bigint;
    targets: MultiTrackTarget[];
  }

  /** Per-target block inside the multi-KCF `probe()` snapshot. */
  export interface MultiTrackerTargetProbe {
    id: string;
    ok: boolean;
    bbox: Rect | null;
    updateMs: number;
    /** Milliseconds since this target was (re-)armed. */
    ageMs: number;
  }

  /** Multi-KCF probe: the aggregate thread meter (name = the node id; busy =
   *  remap + Σ updates) + the per-target block. */
  export interface MultiTrackerMeter extends TrackerMeter {
    targets: MultiTrackerTargetProbe[];
    /** True when tracking runs on the UNDISTORTED frame (created with cal). */
    undistorted: boolean;
  }

  /**
   * Multi-target KCF on ONE free-running C++ thread (real-2, B-25): up to 8
   * independent KCF instances updated sequentially per frame off the camera's
   * shared stream (latest-wins), results batched per frame via async
   * iteration. `arm(id, roi)` (re-)inits that target on the next frame (re-arm
   * = recenter); an arm for a NEW id beyond the cap is dropped (the app owns
   * its own cap). With `cal` the thread fuses the undistort (one full-frame
   * remap shared by all targets) so bboxes are undistorted-frame coordinates.
   */
  export interface MultiKcfTracker
    extends CoreObject<MultiKcfTracker>,
      AsyncIterable<MultiTrackResult> {
    arm(id: string, roi: Rect): void;
    disarm(id: string): void;
    /** Snapshot the native meter + per-target status (out-of-loop safe). */
    probe(): MultiTrackerMeter;
    /** Test-only: add `ms` of artificial per-frame work (drives the drop path). */
    stall(ms: number): void;
  }

  /** Options for `createMultiTracker` (real-2, B-25). */
  export interface CreateMultiTrackerOptions {
    /** Plain persisted calibration JSON ⇒ track on the UNDISTORTED frame
     *  (fused remap; bboxes in undistorted coordinates — what multi-fovea's
     *  pose math expects). Omit for raw-frame tracking. */
    cal?: CameraCalibration | null;
    /** The graph node id (see `graph-contract` `nodeId.kcfMulti`) — becomes
     *  the meter/probe name. Defaults to the legacy-safe `"tracker:multi"`. */
    name?: string;
  }

  /** Create the multi-target KCF thread bound to `camera`'s shared stream
   *  (real-2, B-25) — symmetric with `createTracker`. */
  export function createMultiTracker(
    camera: Camera,
    options?: CreateMultiTrackerOptions,
  ): MultiKcfTracker;
}
