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
    clearTriggers(): void;
    softwareTrigger(): void;
    trigger_source: string;
    readonly trigger_source_options: string[];

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
    readonly timestamp: bigint;
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
    | "Mono16"
    | "BayerGR16"
    | "BayerRG16"
    | "BayerGB16"
    | "BayerBG16";

  export type PixelFormat = PixelFormat8 | PixelFormat16;
}
