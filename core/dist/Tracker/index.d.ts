// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject } from "../types";
import type { CameraCalibration, Mat } from "core/Vision";
import type { Point2d, Rect } from "core/Geometry";
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
    /** Tracked box in frame pixels, or null when tracking is lost. On an
     *  OVERRIDDEN result: a box of the last armed size centered on the override
     *  point (or null if the tracker was never armed). */
    bbox: Rect | null;
    /** Bbox center in frame pixels (computed in native), or null when lost.
     *  On an overridden result this is the override point. */
    center: Point2d | null;
    /** True while the tracker is under a JS `override()` drag: KCF is NOT
     *  updated and `center` is the override point. Flows downstream (matcher →
     *  PID vergence) so each stage acts on the drag correspondingly. */
    overridden: boolean;
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
    /** Engage a drag override at `center` (wide-view point): the tracker stops
     *  updating KCF and emits `{found:true, overridden:true, center}` every
     *  frame until `releaseOverride()`. Atomic (applied on the next frame). */
    override(center: Point2d): void;
    /** Release the override: re-arm KCF at the last override center on the next
     *  frame (roi = last armed size, else a default), then resume normal
     *  (`overridden:false`) results. */
    releaseOverride(): void;
    /** Snapshot the native meter (safe from the orchestrator thread). */
    probe(): TrackerMeter;
    /** Test-only: add `ms` of artificial per-frame work (drives the drop path). */
    stall(ms: number): void;
  }

  /** Create a KCF tracker thread bound to `camera`'s shared stream (WS1 1d).
   *  Optional `name` = the graph node id (becomes the meter/probe name;
   *  defaults to the legacy `"tracker:center"`). */
  export function createTracker(camera: Camera, name?: string): KcfTracker;

  /** Create a CHAINED KCF tracker on another brick's in-process OwnedFrame tap
   *  (controller-node-and-fifo-edges §3.5): `sourcePipeId` is a live convert or
   *  undistort pipe id, so the tracker tracks EXACTLY that brick's view (e.g.
   *  the undistorted C frame the disparity kernel sees). Input transport is
   *  latest-wins (track the freshest frame). Same object surface as
   *  `createTracker`. `name` = the graph node id / meter name (default
   *  `"<sourcePipeId>/kcf"`). Throws if no brick is attached to the pipe. */
  export function createChainedTracker(
    sourcePipeId: string,
    name?: string,
  ): KcfTracker;

  /** Create a higher-fps HYBRID tracker thread bound to `camera`'s shared
   *  stream — a DROP-IN replacement for {@link createTracker}. Engine =
   *  windowed NCC (matchTemplate CCOEFF_NORMED) + dual anchor/adaptive template
   *  + expanding-window ANCHOR re-detection; holds lock on mono needle/blob +
   *  low-texture scenes where GRAY-KCF collapses, and re-acquires after
   *  occlusion/fast motion (KCF is silent-forever-lost). Same object surface /
   *  {@link TrackResult} schema / meter schema as `createTracker`. Optional
   *  `name` = the graph node id (default `"tracker:center"`). See
   *  docs/proposals/hybrid-tracker.md. */
  export function createHybridTracker(camera: Camera, name?: string): KcfTracker;

  /** Create a CHAINED HYBRID tracker on another brick's OwnedFrame tap — the
   *  hybrid twin of {@link createChainedTracker} (same object surface). `name` =
   *  the graph node id / meter name (default `"<sourcePipeId>/hybrid"`). Throws
   *  if no convert/undistort brick is attached to the pipe. */
  export function createChainedHybridTracker(
    sourcePipeId: string,
    name?: string,
  ): KcfTracker;

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

  // ---- IMM motion-predictor brick (prediction-compose-node.md) -------------

  /** One prediction off the native IMM brick (or the zero-coast value returned
   *  by {@link ImmPredictor.ingest}). Mirrors {@link TrackResult} plus the
   *  free-running coasting flag. */
  export interface ImmPrediction {
    /** True when a center is present (a found measurement / a coasting found
     *  emit); false on a predict-only miss. */
    found: boolean;
    /** True when the last measurement was an override (drag) — passthrough. */
    overridden: boolean;
    /** True for a free-running emit propagated BETWEEN measurements (coast > 0)
     *  or a coasted miss. False for the zero-coast `ingest` return. */
    coasting: boolean;
    /** Predicted target center (propagated by coast + delay), or null on a
     *  miss. */
    center: Point2d | null;
    /** Last measurement's bbox shifted by the same predicted delta (size
     *  preserved), or null. */
    bbox: Rect | null;
    /** Last measurement's result counter. */
    seq: number;
    /** Last measurement's device-clock timestamp. */
    deviceTimestamp: bigint;
    /** deviceTimestamp + Δ·1e9 — the device-clock time this prediction is FOR
     *  (informational). */
    propagatedToNs: bigint;
  }

  /** A tracker measurement pushed into the brick — the {@link TrackResult}
   *  shape (only the read fields are required). */
  export interface ImmMeasurement {
    found: boolean;
    overridden?: boolean;
    center: Point2d | null;
    bbox?: Rect | null;
    seq?: number;
    deviceTimestamp?: bigint;
  }

  /** Live-tunable brick params (proposal ruling 2/4): the global prediction
   *  rate + the signed per-triple delay offset. */
  export interface ImmSetParams {
    /** Prediction emit rate (Hz) — clamped 60..1000 on the brick. */
    rateHz?: number;
    /** Signed delay compensation (ms) — the prediction OFFSET. */
    delayMs?: number;
  }

  /** Options for {@link createImmPredictor}. Tuning defaults match the TS
   *  reference `ImmPredictorConfig` (R=4, cvAccelPsd=400, caJerkPsd=5000,
   *  cpPosPsd=1, gate=30, maxGapMs=500). */
  export interface CreateImmPredictorOptions {
    /** Prediction emit rate (Hz), default 600, clamped 60..1000. */
    rateHz?: number;
    /** Signed delay offset (ms), default 0. */
    delayMs?: number;
    /** Graph node id / meter name (default `"imm"`). */
    name?: string;
    measurementVar?: number;
    cvAccelPsd?: number;
    caJerkPsd?: number;
    cpPosPsd?: number;
    gate?: number;
    maxGapMs?: number;
  }

  /**
   * The native IMM motion-predictor brick on its OWN free-running thread
   * (prediction-compose-node.md): `ingest(result)` pushes a tracker measurement
   * at ~60 Hz (runs the IMM measurement cycle, returns the zero-coast
   * prediction); the async iterator emits high-rate coasting predictions
   * (default 600 Hz). `setParams` live-applies rate/delay changes. `probe()`
   * snapshots the thread meter (folds onto the profiler graph node).
   */
  export interface ImmPredictor
    extends CoreObject<ImmPredictor>,
      AsyncIterable<ImmPrediction> {
    /** Push one tracker measurement; returns the reference-equivalent
     *  (zero-coast) prediction. */
    ingest(measurement: ImmMeasurement): ImmPrediction;
    /** Live rate/delay change. */
    setParams(params: ImmSetParams): void;
    /** Snapshot the native thread meter (out-of-loop safe). */
    probe(): TrackerMeter;
  }

  /** Create the native IMM predictor brick. The disparity-scope session creates
   *  one on tracking activation and feeds it every tracker result. */
  export function createImmPredictor(
    options?: CreateImmPredictorOptions,
  ): ImmPredictor;
}
