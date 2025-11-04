// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

type Awaitable<T> = T | Promise<T>;
type BufferLike = Buffer | ArrayBuffer | ArrayBufferView;
type TypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array;

declare module "core" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    // Explicitly cleanup all resources (cameras, streams, frames, etc.)
    export function cleanup(): void;

    class CoreObject<T extends CoreObject<T>> {
        /**
         * Hex string ID of the underlying native object.
         * Can be used to check if two JS objects point to the same native object.
         */
        readonly id: string;
        /**
         * Creates another reference to the same underlying native object.
         * Releasing either reference will not affect the other.
         */
        public ref(): T;
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
        view(): Promise<Mat>;
        view(
            format: PixelFormat8,
            buffer?: BufferLike | null
        ): Promise<Mat<Uint8Array>>;
        view(
            format: PixelFormat16,
            buffer?: BufferLike | null
        ): Promise<Mat<Uint16Array>>;
    }

    export class Stream<T> extends CoreObject<Stream<T>> {
        // Skip frames if the consumer is slower than the producer.
        // Generates null if consumer is faster than producer.
        // Consumer MUST yield (await) upon null so producer can push data.
        [Symbol.iterator](): IterableIterator<T | null>;
        // Queue all frames
        [Symbol.asyncIterator](): AsyncIterableIterator<T>;
    }

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

    type PixelFormat16 = "Mono16" | "BayerGR16" | "BayerRG16" | "BayerGB16";

    type PixelFormat = PixelFormat8 | PixelFormat16;

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
        // Properties
        readonly connected: boolean;
        // Async API
        get<T>(fn: PacketFactory<T>): Promise<PacketInstance<T>>;
        set<T>(
            fn: PacketFactory<T>,
            arg: T | BufferLike
        ): Promise<PacketInstance<T>>;
        release(): void;
        // Construction
        constructor(
            port: string,
            baudrate?: number // default 115200
        );
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

    export class ArUcoDetector extends CoreObject<ArUcoDetector> {
        constructor(type: PreDefinedDictionary);
        detect(
            frame: Frame,
            scale?: number // default 1.0
        ): Promise<ArUcoDetectResults>;
        stream(
            stream: Stream<Frame>,
            scale?: number // default 1.0
        ): Stream<ArUcoDetectResults>;
        pattern(id: number): (0 | 1)[][] & Size;
    }

    type ArUcoDetectResult = { id: number } & Size & Point[];
    type ArUcoDetectResults = ArUcoDetectResult[] & { frame: Frame };

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

    export type Size<T = number> = { width: T; height: T };
    export type Point3d<T = number> = { x: T; y: T; z: T };
    export type Point2d<T = number> = { x: T; y: T };
    export type Point = Point2d;
    export type Rect = Point2d & Size;
    export type Mat<A extends TypedArray = TypedArray> = A & {
        // Mat.length === shape.reduce((a, b) => a * b, channels)
        shape: number[];
        channels: number;
    };

    export type CameraCalibration = {
        date: Date;
        // Sensor Size - width x height in pixels
        sensor_size: Size;
        // Camera Matrix - 3 row x 3 col
        camera_matrix: Mat<Float64Array>;
        // Distortion coefficients - 1 row x N col
        dist_coeffs: Mat<Float64Array>;
        // Rectification transform vectors - 3 row x 3 col
        rvecs: Mat<Float64Array>[];
        // Projection transform vectors - 3 row x 4 col
        tvecs: Mat<Float64Array>[];
    };

    // Default: { max_count: 30, epsilon: 1e-8 }
    export type TermCriteria = {
        // Type is auto deducted.
        max_count?: number;
        epsilon?: number;
    };

    class Undistort {
        constructor(calibration: CameraCalibration);
        readonly calibration: CameraCalibration;
        get sensor_size(): Size;
        get focal(): Point2d;
        get center(): Point2d;
        get fov(): Point2d; // X and Y field of view in radians
        apply(mat: Mat): Mat;
        undistort(points: Point2d[]): Point2d[];
        distort(points: Point2d[]): Point2d[];
        angular(
            points: Point2d[],
            undistort?: boolean // default: false
        ): Point2d[];
        position(
            angles: Point2d[],
            distort?: boolean // default: false
        ): Point2d[];
    }

    type SolvePnPMethod =
        | "ITERATIVE"
        | "EPNP"
        | "P3P"
        | "DLS"
        | "UPNP"
        | "AP3P"
        | "IPPE"
        | "IPPE_SQUARE"
        | "SQPNP";

    type InterpolationFlag =
        | "NEAREST"
        | "LINEAR"
        | "CUBIC"
        | "AREA"
        | "LANCZOS4";

    type TemplateMatchMode =
        | "SQDIFF"
        | "SQDIFF_NORMED"
        | "CCORR"
        | "CCORR_NORMED"
        | "CCOEFF"
        | "CCOEFF_NORMED";

    class Projector extends CoreObject<Projector> {
        /**
         * Finds an object pose from 3D-2D point correspondences.
         * @param img_points Array of corresponding 2D image points
         * @param obj_points Array of 3D object points
         * @param calibration Camera calibration data (optional - uses identity matrix if not provided)
         * @param use_extrinsic_guess Use initial guess for rvec/tvec (default: false)
         * @param method Method to use (default: ITERATIVE)
         * @returns Object containing rvec (rotation vector) and tvec (translation vector)
         */
        static solve(
            img_points: Point2d[],
            obj_points: Point3d[],
            calibration?: CameraCalibration | null,
            use_extrinsic_guess?: boolean,
            method?: SolvePnPMethod // default: "ITERATIVE"
        ): Promise<Projector>;
        get rvec(): Mat<Float64Array>;
        get tvec(): Mat<Float64Array>;
        get mtx(): Mat<Float64Array>;
        get dist(): Mat<Float64Array>;
        obj2img(obj_points: Point3d[]): Point2d[];
        img2obj(
            img_points: Point2d[],
            z?: number // default: 0
        ): Point3d[];
    }

    export type Pixel = Point2d & { value: number };

    export class Vision {
        static slice<T extends TypedArray>(mat: Mat<T>, rect: Rect): Mat<T>;

        static resize<T extends TypedArray>(
            mat: Mat<T>,
            size?: Partial<Size> | null,
            mode?: InterpolationFlag // default: "LINEAR"
        ): Awaitable<Mat<T>>;

        static disparity(
            a: Frame,
            b: Frame,
            norm?: boolean // default: false
        ): Promise<Mat<Uint8Array>>;

        static minMaxLoc(mat: Mat): [Pixel, Pixel] & { min: Pixel; max: Pixel };

        static matchTemplate(
            haystack: Mat,
            needle: Mat,
            method?: TemplateMatchMode // default: "SQDIFF_NORMED"
        ): Promise<Mat<Float32Array>>;

        static findChessboardCorners(
            mat: Mat,
            pattern_size: Size | number
        ): Promise<Point[]>;

        static cornerSubPix(
            mat: Mat,
            corners: Point[],
            win_size?: Size | number | null, // default 5
            zero_zone?: Size | number | null, // default -1
            term_criteria?: TermCriteria | null // default: refer to TermCriteria
        ): Promise<Point[]>;

        static calibrateCamera(
            sensor_size: Size,
            img_points: Point2d[][],
            obj_points: Point3d[][],
            term_criteria?: TermCriteria | null // default: refer to TermCriteria
        ): Promise<CameraCalibration>;

        static Undistort: typeof Undistort;
        static Projector: typeof Projector;
    }

    export class Log {
        static error(...args: any[]): void;
        static warn(...args: any[]): void;
        static info(...args: any[]): void;
        static verbose(...args: any[]): void;
    }

    // default: { ply: [2, 1, 0, -1, -2] }
    // For input of {x, y}, will expand to:
    // [x^2, y^2, xy, x, y, 1, 1/x, 1/y, 1/x^2, 1/y^2, 1/xy]
    type RegressionConfig = {
        ply: number[]; // polynomial degrees to expand
        log: number[]; // logarithmic degrees to expand
        exp: number[]; // exponential degrees to expand
    };

    export class Regression<
        I extends Record<string, number>,
        O extends Record<string, number>
    > {
        constructor(
            features: (keyof I)[],
            targets: (keyof O)[],
            config?: RegressionConfig
        );
        fit(i: I[], o: O[]): this;
        expand(i: I): number[];
        predict(i: I): O;
        get features(): (keyof I)[];
        get targets(): (keyof O)[];
        get expansions(): string[];
        get parameters(): Record<keyof O, number[]>;
        toString(): string;
    }
}
