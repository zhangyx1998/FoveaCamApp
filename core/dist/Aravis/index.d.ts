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

    // Stream control
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
   * Out-of-loop probe of every ACTIVE per-camera undistort thread (real-1g,
   * B-23) → `{ [pipeId]: ProbeSnapshot }` — same shape as `converterProbeAll`,
   * folds into `perfSnapshot.workloads` identically. Parked/detached pipes are
   * absent — no stale rows.
   */
  export function undistortProbeAll(): Record<string, ProbeSnapshot>;

  /**
   * Attach a camera→pipe UNDISTORT producer thread (real-1g, B-23): convert to
   * the pipe's advertised `spec.pixelFormat` then full-frame `cv::remap` with
   * maps built NATIVELY at attach from the plain persisted calibration JSON
   * (never pass the `Vision.Undistort` instance). Gated by the pipe's own
   * consumer refcount (parks when no consumer). The pipe must be advertised
   * first; `pipeId` is the graph node id (see `graph-contract` builders).
   */
  export function attachUndistortPipe(
    camera: Camera,
    pipeId: string,
    calibration: CameraCalibration,
  ): boolean;

  /** Detach + join the undistort producer. Idempotent (false if unknown). */
  export function detachUndistortPipe(pipeId: string): boolean;

  /** Options for `attachFoveaPipe` (real-2, B-24). */
  export interface FoveaPipeOptions {
    /** Initial crop rect, in source (sensor / undistorted-frame) pixels. */
    rect: Rect;
    /** Plain persisted calibration JSON ⇒ the fovea is an UNDISTORTED crop
     *  (fused map-ROI remap). Omit for a raw crop of the converted frame. */
    cal?: CameraCalibration | null;
  }

  /**
   * Attach a spawn/cancel-able FOVEA CROP producer thread (real-2, B-24): a
   * DYNAMIC pipe with C-20 semantics — advertise with `maxWidth`/`maxHeight`/
   * `maxBytes` (the ring footprint); every frame carries its ACTIVE w/h and
   * FRAME-BOUND crop origin in the v4 slot header (surfaced by the reader as
   * `width`/`height`/`originX`/`originY`). Steer live via `setFoveaRect`.
   * Spawn = advertise + attach + connect; cancel = disconnect + detach +
   * close + drop (broker epochs make reused ids safe).
   */
  export function attachFoveaPipe(
    camera: Camera,
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
    /** True when the fovea crops the UNDISTORTED image (cal was given). */
    undistorted: boolean;
  }

  /**
   * Out-of-loop probe of every ACTIVE fovea thread (real-2, B-24) →
   * `{ [pipeId]: FoveaProbeSnapshot }` — keys AND meter names are the node
   * ids. Folds into `perfSnapshot.workloads`/`graphTopology()` identically.
   */
  export function foveaProbeAll(): Record<string, FoveaProbeSnapshot>;
}
