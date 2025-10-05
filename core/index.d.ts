// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

type Awaitable<T> = T | Promise<T>;

declare module "core" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    class CoreObject {
        /**
         * Hex string ID of the underlying native object.
         * Can be used to check if two JS objects point to the same native object.
         */
        readonly id: string;
        /**
         * Releases underlying native resources.
         * After calling release(), any further access to the object will throw an error.
         * It is safe to call release() multiple times.
         */
        public release(): void;
    }

    interface Range {
        min: number;
        max: number;
    }

    type AutoMode = "Off" | "Once" | "Continuous";
    type AcquisitionMode = "Continuous" | "SingleFrame" | "MultiFrame";

    export class Camera extends CoreObject {
        static list(): Array<Camera>;

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
        readonly stream: Stream;
    }

    export class Frame extends CoreObject {
        readonly width: number;
        readonly height: number;
        readonly timestamp: bigint;
        view(format?: PixelFormat, buffer?: BufferSource): ArrayBuffer;
    }

    export class Stream extends CoreObject {
        // Skip frames if the consumer is slower than the producer.
        // Generates null if consumer is faster than producer.
        // Consumer MUST yield (await) upon null so producer can push data.
        [Symbol.iterator](): IterableIterator<Frame | null>;
        // Queue all frames
        [Symbol.asyncIterator](): AsyncIterableIterator<Frame>;
    }

    type PixelFormat =
        | "Mono8"
        | "Mono16"
        | "RGB8"
        | "BGR8"
        | "RGBA8"
        | "BGRA8"
        | "BayerGR8"
        | "BayerRG8"
        | "BayerGB8"
        | "BayerBG8"
        | "BayerGR16"
        | "BayerRG16"
        | "BayerGB16";
}
