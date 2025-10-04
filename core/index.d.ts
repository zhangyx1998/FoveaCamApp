// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

type Awaitable<T> = T | Promise<T>;

declare module "core" {
    /** Path to the resolved native module */
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

    export class Camera extends CoreObject {
        static list(): Array<Camera>;
        readonly model: string;
        readonly serial: string;
        readonly sensor: string;
        // configure(key: string, value: number, type = "int"): boolean;
        // configure(key: string, value: number, type = "float"): boolean;
        // configure(key: string, value: string): boolean;

        fps: number;
        fps_enable: boolean;

        exposure: number;
        exposure_auto: "Off" | "Continuous" | "Once";

        gain: number;
        gain_auto: "Off" | "Continuous" | "Once";

        acquire(timeout = 1000): Promise<Frame>;
        // A camera can only have one active stream at a time.
        readonly stream: Stream | null;
        /**
         * Creates a stream, holds startAcquisition() until the first consumer
         * (i.e. async iterator) is attached to the stream.
         * Throws if a stream already exists.
         */
        start(): Stream;
        /**
         * An active stream can be terminated by calling stop()
         * This will cause all async iterators to end, and set stream to null.
         * Does nothing if no active stream.
         */
        stop(): void;
    }

    export class Frame extends CoreObject {
        readonly width: number;
        readonly height: number;
        readonly format: PixelFormat;
        readonly timestamp: bigint;
        view(format?: PixelFormat, buffer?: BufferSource): ArrayBuffer;
    }

    export class Stream extends CoreObject {
        // Skip frames if the consumer is slower than the producer.
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
