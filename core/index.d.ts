// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

type Awaitable<T> = T | Promise<T>;
type BufferLike = Buffer | ArrayBuffer | ArrayBufferView;

declare module "core" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    // Explicitly cleanup all resources (cameras, streams, frames, etc.)
    export function cleanup(): void;

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

    export class Frame extends CoreObject {
        readonly width: number;
        readonly height: number;
        readonly timestamp: bigint;
        view(format?: PixelFormat, buffer?: BufferLike): Promise<ArrayBuffer>;
    }

    export class Stream<T> extends CoreObject {
        // Skip frames if the consumer is slower than the producer.
        // Generates null if consumer is faster than producer.
        // Consumer MUST yield (await) upon null so producer can push data.
        [Symbol.iterator](): IterableIterator<T | null>;
        // Queue all frames
        [Symbol.asyncIterator](): AsyncIterableIterator<T>;
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

    // Internally distinguishable objects that can be converted to buffer.
    const bufferAccessor: unique symbol;
    const factoryAccessor: unique symbol;
    const propNameAccessor: unique symbol;
    type PacketInstance<I, O = I> = Readonly<O> & {
        readonly [bufferAccessor]: ArrayBuffer;
    };

    type PacketFactory<I, O = I> = ((
        v: I | BufferLike
    ) => PacketInstance<I, O>) & {
        readonly [propNameAccessor]: string;
        readonly [bufferAccessor]: null;
    };

    export class Protocol {
        static readonly Log: PacketFactory<String>;
        static readonly System: {
            readonly Info: PacketFactory<String>;
            readonly Version: PacketFactory<FirmwareVersion> &
                Readonly<FirmwareVersion>;
            readonly Reset: PacketFactory<ResetType>;
            readonly Enable: PacketFactory<Boolean>;
        };
        static readonly Config: {
            readonly Log: PacketFactory<LogLevel>;
            readonly LPF: PacketFactory<Number>;
            readonly Bias: PacketFactory<Number>;
        };
        static readonly Command: {
            readonly Actuate: PacketFactory<{
                left: MirrorPosition;
                right: MirrorPosition;
                settle_time?: number; // in microseconds
                complete_time?: number; // in microseconds
            }>;
            readonly Trigger: PacketFactory<Number>;
        };
        // Need to be registered to forward outbound data
        __tx__: ((data: ArrayBuffer) => any) | null;
        // Called by serial data receiver to parse inbound data
        __rx__(buffer: BufferLike);
        // Async API
        get<T>(fn: PacketFactory<T>): Promise<PacketInstance<T>>;
        set<T>(
            fn: PacketFactory<T>,
            arg: T | BufferLike
        ): Promise<PacketInstance<T>>;
    }

    type RawPacket = {
        method: ProtocolMethod;
        property: ProtocolProperty;
        sequence: number;
        payload: ArrayBuffer;
    };
    type FirmwareVersion = {
        major: number;
        minor: number;
        patch: number;
    };
    type ResetType = "SOFT" | "HARD";
    type LogLevel = "OFF" | "ERR" | "WARN" | "INFO" | "VERB";
    type MirrorPosition = [number, number, number, number];
    type ProtocolMethod = "NOP" | "GET" | "SET" | "ACK" | "REJ" | "SYN";
    type ProtocolProperty =
        | "NONE"
        | "SYS_INFO"
        | "SYS_VERSION"
        | "SYS_RESET"
        | "SYS_ENABLE"
        | "CFG_LOG"
        | "CFG_LPF"
        | "CFG_BIAS"
        | "CMD_ACTUATE"
        | "CMD_TRIGGER"
        | "LOG";

    export class ArUcoDetector extends CoreObject {
        static enhance(
            frame: Frame,
            scale?: number = 1.0
        ): Promise<ArrayBuffer>;
        constructor(type: PreDefinedDictionary);
        detect(
            frame: Frame,
            scale?: number = 1.0
        ): Promise<ArUcoDetectResult[]>;
        stream(
            stream: Stream<Frame>,
            scale?: number = 1.0
        ): Stream<ArUcoDetectResult[]>;
    }

    type Corner = { x: number; y: number };
    type ArUcoDetectResult = { id: number; w: number; h: number } & Corner[];

    type PreDefinedDictionary =
        | "4X4_50"
        | "4X4_100"
        | "4X4_250"
        | "4X4_1000"
        | "5X5_50"
        | "5X5_100"
        | "5X5_250"
        | "5X5_1000"
        | "6X6_50"
        | "6X6_100"
        | "6X6_250"
        | "6X6_1000"
        | "7X7_50"
        | "7X7_100"
        | "7X7_250"
        | "7X7_1000"
        | "ARUCO_ORIGINAL"
        | "APRILTAG_16h5"
        | "APRILTAG_25h9"
        | "APRILTAG_36h10"
        | "APRILTAG_36h11"
        | "ARUCO_MIP_36h12";
}
