// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject, Stream } from "../types";
import type { CameraCalibration, Mat } from "core/Vision";
import type { Rect } from "core/Geometry";
import type { ProbeSnapshot } from "core/Pipe";

declare module "core/Aravis" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  interface Range {
    min: number;
    max: number;
  }

  type AutoMode = "Off" | "Once" | "Continuous";
  type AcquisitionMode = "Continuous" | "SingleFrame" | "MultiFrame";

  export class Camera extends CoreObject<Camera> {
    static list(): Promise<Array<Camera>>;

    // Device identification
    readonly physical_id: string;
    readonly device_id: string;
    readonly vendor: string;
    readonly model: string;
    readonly serial: string;

    // Pixel format control. Options are filtered to native-supported camera
    // readout formats that Frame.view("BGRA8") can preview.
    pixel_format: PixelFormat;
    readonly pixel_format_options: PixelFormat[];

    // Acquisition control
    acquisition_mode: AcquisitionMode;
    frame_count: number;
    readonly frame_count_range: Range;

    // Frame rate control
    frame_rate_enable: boolean;
    readonly frame_rate_available: boolean;
    frame_rate: number;
    readonly frame_rate_range: Range;

    // Trigger control
    readonly trigger_options: string[];
    /** Convenience: sets TriggerMode=On + TriggerSelector/TriggerSource in
     *  one call (`arv_camera_set_trigger`). `mode` is one of
     *  `trigger_options` (e.g. "FrameStart", or "Off" to disable). */
    setTrigger(mode: string): void;
    clearTriggers(): void;
    softwareTrigger(): void;
    /** Hardware-quiescence failsafe: `arv_camera_stop_acquisition`
     *  (AcquisitionStop + TLParamsLocked=0 in Aravis's canonical order).
     *  Safe on an idle camera. The main-process janitor uses this to stop a
     *  camera left streaming by a crashed orchestrator — a locked camera
     *  rejects every config write with USB3Vision access-denied. */
    stopAcquisition(): void;
    trigger_source: string;
    readonly trigger_source_options: string[];

    // Generic GenICam feature access — for anything without a dedicated
    // accessor above, e.g. configuring a strobe/line output as
    // ExposureActive for synced capture (LineSelector + LineMode +
    // LineSource) — see docs/history/refactor/synced-capture.md §6.
    getFeature(name: string): string;
    /** Read an integer GenICam node (e.g. `Width`/`Height`) — `getFeature` uses
     *  `arv_camera_get_string` and throws on integer nodes. */
    getFeatureInt(name: string): number;
    setFeature(name: string, value: string): void;
    executeFeature(name: string): void;

    // Exposure control
    readonly exposure_time_available: boolean;
    readonly exposure_auto_available: boolean;
    exposure: number;
    readonly exposure_range: Range;
    exposure_auto: AutoMode;
    setExposureMode(mode: string): boolean;

    // Gain control
    readonly gain_available: boolean;
    readonly gain_auto_available: boolean;
    selectGain(selector: string): boolean;
    readonly gain_options: string[];
    gain: number;
    readonly gain_range: Range;
    gain_auto: AutoMode;

    // Black level control
    readonly black_level_available: boolean;
    readonly black_level_auto_available: boolean;
    selectBlackLevel(selector: string): boolean;
    readonly black_level_options: string[];
    black_level: number;
    readonly black_level_range: Range;
    black_level_auto: AutoMode;

    // Frame acquisition
    grab(timeout?: number): Promise<Frame>;

    /**
     * MANUAL clock-recalibration trigger (unified-time, 2026-07-08). The
     * calibration LIFECYCLE is native: the camera's OWNER THREAD runs the
     * initial TimestampLatch pass at device initialization and a drift
     * re-run every 30 s — this method is a thin synchronous nudge onto the
     * same guarded routine (per-DEVICE mutex: serializes against this
     * camera's own drift pass; initial passes additionally serialize
     * bus-wide on a global mutex). BLOCKS the calling thread for ~n GenICam
     * control roundtrips. On success the offset is atomically OWNER-APPLIED:
     * every subsequent frame's `deviceTimestamp` (JS frames, SHM slot
     * headers, native taps, KCF results) is already in the `steadyNowNs`
     * host domain. Throws when the camera lacks the latch features (the
     * on-demand retry for models whose init pass failed — they stay at
     * offset 0, raw device counter).
     */
    calibrateClock(n?: number): CameraClockCalibration;

    /**
     * The stored clock calibration + stability row for this camera, or null
     * until a calibration (owner-thread init/drift or manual) succeeds.
     * `ageNs` is computed at read time; `driftPpm` needs >= 2 runs in the
     * native ring (last 8 kept). All values in the `steadyNowNs` domain.
     */
    readonly clockCalibration: CameraClockStability | null;

    // Stream control
    /** Shared frame stream view — created LAZILY on first read (and cached):
     *  merely listing/opening cameras creates no native stream, and
     *  `release()` cascades to it (the stream held the device claim past
     *  release until GC — janitor rig find 2026-07-08). */
    readonly stream: Stream<Frame>;
  }

  export class Frame extends CoreObject<Frame> {
    readonly width: number;
    readonly height: number;
    /** Back-compat alias for `deviceTimestamp`. */
    readonly timestamp: bigint;
    /** Camera/device-clock timestamp from `arv_buffer_get_timestamp`. */
    readonly deviceTimestamp: bigint;
    /** Host system timestamp from `arv_buffer_get_system_timestamp`. */
    readonly systemTimestamp: bigint;
    /** Native-style alias for `deviceTimestamp`. */
    readonly device_timestamp: bigint;
    /** Native-style alias for `systemTimestamp`. */
    readonly system_timestamp: bigint;
    readonly raw: Mat;
    readonly raw_format: PixelFormat;
    view(): Promise<Mat>;
    view(
      format: PixelFormat8,
      buffer?: BufferLike | null,
    ): Promise<Mat<Uint8Array>>;
    view(
      format: PixelFormat16,
      buffer?: BufferLike | null,
    ): Promise<Mat<Uint16Array>>;
    save(path: string): void;
  }

  export type { Stream } from "../types";

  type PixelFormat8 =
    | "Mono8"
    | "RGB8"
    | "BGR8"
    | "RGBA8"
    | "BGRA8"
    | "BayerGR8"
    | "BayerRG8"
    | "BayerGB8"
    | "BayerBG8";

  type PixelFormat16 =
    "Mono16" | "BayerGR16" | "BayerRG16" | "BayerGB16" | "BayerBG16";

  /**
   * GenICam 12-bit packed wire formats. These appear only as a Frame's
   * `raw_format` (and as values selectable via `Camera.pixel_format`); the
   * native readout unpacks them into a 16-bit single-channel Mat. They are not
   * valid targets for `Frame.view()`.
   */
  type PixelFormat12p =
    "Mono12p" | "BayerGR12p" | "BayerRG12p" | "BayerGB12p" | "BayerBG12p";

  export type PixelFormat = PixelFormat8 | PixelFormat16 | PixelFormat12p;

  /**
   * Out-of-loop probe of every ACTIVE per-camera BGRA converter thread
   * (WS1 real-1e, B-18) → `{ [pipeId]: ProbeSnapshot }` — the same snapshot
   * shape as `Pipe.probeAll()` and the tracker meter, so it folds straight into
   * `perfSnapshot.workloads` and renders identically in the profiler. A parked
   * (refcount-0) or detached converter is absent from the map — no stale rows.
   */
  export function converterProbeAll(): Record<string, ProbeSnapshot>;

  /**
   * Attach the CONVERT brick: builds a per-camera converter thread targeting
   * the pipe's advertised pixelFormat and gates the SHM subscriber on the
   * pipe's consumer refcount (parks when no demand). The pipe must be
   * advertised first; `pipeId` is the graph node id (`camera/<serial>/convert`).
   * Throws on an unknown pipe.
   */
  export function attachCameraPipe(camera: Camera, pipeId: string): boolean;

  /** Detach + join the convert producer. Idempotent (false if unknown). */
  export function detachCameraPipe(pipeId: string): boolean;

  /** One clock-calibration result (unified-time): `hostNs = rawDeviceNs +
   *  offsetNs`, everything in the `steadyNowNs` domain. `jitterNs` =
   *  p90 − min over the candidate offsets (the min-filter's confidence). */
  export interface CameraClockCalibration {
    offsetNs: bigint;
    jitterNs: bigint;
    samples: number;
    atNs: bigint;
  }

  /** The stability row: the most recent calibration + `ageNs` (steadyNowNs −
   *  atNs, at read time) and `driftPpm` ((Δoffset/Δat)×1e6 between the two
   *  most recent runs; null with fewer than 2). */
  export interface CameraClockStability extends CameraClockCalibration {
    ageNs: bigint;
    driftPpm: number | null;
  }

  /**
   * Bulk clock-stability read for the 1 Hz clocks poll: every camera with at
   * least one successful calibration → `{ [serial]: CameraClockStability }`.
   * Uncalibrated cameras (latch-unsupported, or init pass not run yet) are
   * absent. Cheap: one native map scan, no device I/O.
   */
  export function clockStabilityAll(): Record<string, CameraClockStability>;

  /** The clock-metrics PUSH row (`onClockMetrics`): the stability row plus
   *  the camera it belongs to. */
  export interface ClockMetricsRow extends CameraClockStability {
    serial: string;
  }

  /**
   * Arm (callback) / disarm (null) the clock-metrics PUSH channel: after
   * EVERY successful calibration — owner-thread init/drift or a manual
   * `calibrateClock` — the row is delivered to `cb` on the orchestrator
   * main thread via the native dispatcher. While disarmed the owner threads
   * skip the dispatch entirely (one lock-free atomic check — zero
   * cross-thread cost unobserved). Main-thread only; the slot disarms itself
   * at env teardown. ONE callback per process (last set wins).
   */
  export function onClockMetrics(cb: ((row: ClockMetricsRow) => void) | null): void;

  /** `undistortProbeAll` snapshot: the shared meter shape + the v2 variant
   *  surface (unified-time-and-topology §5). */
  export interface UndistortProbeSnapshot extends ProbeSnapshot {
    variant: "intrinsic" | "homography";
    /** The owning CAMERA's clock-calibration state (owner-applied dt,
     *  unified-time): true once `calibrateClock` succeeded for the serial
     *  resolved at attach. False = frames carry the raw device counter and
     *  the H lookup runs uncalibrated. Irrelevant for `intrinsic`. */
    calibratedClock: boolean;
    /** Frames passed through UNTOUCHED (homography variant with an empty
     *  mirror-history ring) — nonzero means H samples aren't flowing yet. */
    passthrough: number;
  }

  /**
   * Out-of-loop probe of every ACTIVE undistort brick → `{ [pipeId]:
   * UndistortProbeSnapshot }` — the shared meter shape folds into
   * `perfSnapshot.workloads` identically. Parked/detached pipes are absent —
   * no stale rows.
   */
  export function undistortProbeAll(): Record<string, UndistortProbeSnapshot>;

  /** Variant selector for `attachUndistortPipe` (unified-time-and-topology
   *  §5): INTRINSIC (center camera — cached `initUndistortRectifyMap` maps
   *  from the plain persisted calibration JSON) or HOMOGRAPHY (L/R
   *  mirror-steered — per-frame `warpPerspective` with H looked up from the
   *  native mirror-history ring by the frame's host-ns time). */
  export type UndistortPipeOptions =
    | CameraCalibration // legacy positional form ⇒ intrinsic
    | { cal: CameraCalibration }
    | { homography: true; ringCapacity?: number };

  /**
   * Attach an UNDISTORT brick v2 (unified-time-and-topology §5): consumes the
   * CONVERTER's in-process owned-frame tap — BGRA/converted input only, never
   * the raw Bayer stream. `source` is the convert brick's pipeId (preferred —
   * shares the live converter; demand propagates: this brick running keeps
   * the converter awake even with zero convert-pipe SHM consumers) or a
   * Camera (legacy — a private `<pipeId>#convert` converter is created).
   * Gated by the pipe's own consumer refcount (parks when no demand). The
   * pipe must be advertised first; `pipeId` is the graph node id.
   */
  export function attachUndistortPipe(
    source: Camera | string,
    pipeId: string,
    options: UndistortPipeOptions,
  ): boolean;

  /** Detach + join the undistort producer. Idempotent (false if unknown). */
  export function detachUndistortPipe(pipeId: string): boolean;

  /**
   * Push one mirror/H sample into a HOMOGRAPHY undistort brick's native
   * history ring (unified-time-and-topology §3/§5): `h` is the 3×3 matrix,
   * row-major, 9 doubles; `hostNs` its host-clock timestamp. Designed for the
   * ~1 kHz actuation loop (mutex-guarded native ring; no per-frame JS). The
   * undistort thread warps each frame with the entry nearest ≤ (linearly
   * interpolated) its `deviceTimestamp` — which is already OWNER-APPLIED
   * host time on a calibrated camera (unified-time: the camera stamps its dt
   * at Frame creation). Returns false for an unknown pipe or a
   * non-homography variant.
   */
  export function pushHomography(
    pipeId: string,
    hostNs: bigint,
    h: Float64Array,
  ): boolean;

  /**
   * @deprecated NO-OP, always returns 0 (unified-time ruling 2026-07-08:
   * timestamps are OWNER-APPLIED — the camera stamps its calibrated dt at
   * Frame creation, so per-brick offsets no longer exist). Kept only until
   * the last JS caller migrates to `camera.calibrateClock` /
   * the owner-thread lifecycle; then this export is deleted.
   */
  export function setClockOffset(
    pipeIdOrSerial: string,
    offsetNs: bigint,
  ): number;

  /** Options for `attachFoveaPipe` (re-based on the undistort brick,
   *  unified-time-and-topology §5). */
  export interface FoveaPipeOptions {
    /** Initial crop rect, in SOURCE-frame pixels (the undistorted frame when
     *  chained on an undistort brick; the converted frame otherwise). */
    rect: Rect;
    /** LEGACY (Camera source only): plain persisted calibration JSON ⇒ a
     *  private `<pipeId>#convert` + `<pipeId>#undistort` intrinsic chain is
     *  built for this fovea. REJECTED with a string source — chain on an
     *  undistort pipe instead (the fused map-ROI path is retired). */
    cal?: CameraCalibration | null;
  }

  /**
   * Attach a spawn/cancel-able FOVEA CROP brick: a PLAIN ROI copy of the
   * source brick's frames (chain convert → undistort → fovea — undistortion
   * happens once upstream; N foveas share it). `source` is an undistort pipeId
   * (preferred), a convert pipeId (raw crop), or a Camera (legacy — a private
   * chain is created, see `FoveaPipeOptions.cal`). Demand propagates: this
   * brick running keeps the whole upstream chain awake. The pipe is DYNAMIC
   * with C-20 semantics — advertise with `maxWidth`/`maxHeight`/`maxBytes`
   * (the ring footprint); every frame carries its ACTIVE w/h and FRAME-BOUND
   * crop origin in the v4 slot header (surfaced by the reader as
   * `width`/`height`/`originX`/`originY`). Steer live via `setFoveaRect`.
   * Spawn = advertise + attach + connect; cancel = disconnect + detach +
   * close + drop (broker epochs make reused ids safe).
   */
  export function attachFoveaPipe(
    source: Camera | string,
    pipeId: string,
    options: FoveaPipeOptions,
  ): boolean;

  /**
   * Live-steer a fovea crop (applied on the NEXT frame; clamped to the frame
   * domain + the ring's max footprint). No re-attach, no gate churn. Returns
   * false for an unknown pipe id.
   */
  export function setFoveaRect(pipeId: string, rect: Rect): boolean;

  /** Detach + join the fovea producer. Idempotent (false if unknown). */
  export function detachFoveaPipe(pipeId: string): boolean;

  /** `foveaProbeAll` snapshot: the shared meter shape + the last produced
   *  frame's FRAME-BOUND rect (byte-rate math for variable-size pipes). */
  export interface FoveaProbeSnapshot extends ProbeSnapshot {
    activeWidth: number;
    activeHeight: number;
    originX: number;
    originY: number;
    /** True when the fovea crops UNDISTORTED space (its source brick is an
     *  undistort node — shared or legacy-private). */
    undistorted: boolean;
  }

  /**
   * Out-of-loop probe of every ACTIVE fovea thread (real-2, B-24) →
   * `{ [pipeId]: FoveaProbeSnapshot }` — keys AND meter names are the node
   * ids. Folds into `perfSnapshot.workloads`/`graphTopology()` identically.
   */
  export function foveaProbeAll(): Record<string, FoveaProbeSnapshot>;
}
