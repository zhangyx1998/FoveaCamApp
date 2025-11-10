// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { Awaitable, BufferLike, TypedArray, CoreObject } from "../types";

declare module "core/Controller" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

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

    export const Protocol: {
        readonly Log: PacketFactory<String>;
        readonly System: {
            readonly Info: PacketFactory<String>;
            readonly Version: PacketFactory<FirmwareVersion> &
                Readonly<FirmwareVersion>;
            readonly Reset: PacketFactory<ResetType>;
            readonly Enable: PacketFactory<Boolean>;
        };
        readonly Config: {
            readonly Log: PacketFactory<LogLevel>;
            readonly LPF: PacketFactory<Number>;
            readonly Bias: PacketFactory<Number>;
        };
        readonly Command: {
            readonly Actuate: PacketFactory<{
                left: AnalogChannels;
                right: AnalogChannels;
                settle_time?: number; // in microseconds
                complete_time?: number; // in microseconds
            }>;
            readonly Trigger: PacketFactory<Number>;
        };
    };

    export class Device {
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

    export type FirmwareVersion = {
        major: number;
        minor: number;
        patch: number;
    };
    export type ResetType = "SOFT" | "HARD";
    export type LogLevel = "OFF" | "ERR" | "WARN" | "INFO" | "VERB";
    export type AnalogChannels = [number, number, number, number];
}
