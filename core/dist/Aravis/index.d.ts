// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject, Stream } from "../types";
import type { Mat } from "core/Vision";

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

    // Pixel format control
    pixel_format: PixelFormat;
    readonly pixel_format_options: string[];

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
    trigger_source: string;
    readonly trigger_source_options: string[];

    // Generic GenICam feature access — for anything without a dedicated
    // accessor above, e.g. configuring a strobe/line output as
    // ExposureActive for synced capture (LineSelector + LineMode +
    // LineSource) — see docs/refactor/synced-capture.md §6.
    getFeature(name: string): string;
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
}
