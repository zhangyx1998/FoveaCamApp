// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
declare module "core" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    // Explicitly cleanup all resources (cameras, streams, frames, etc.)
    export function cleanup(): void;

    /**
     * THE native host time authority (unified-time §1): libc++
     * `std::chrono::steady_clock` as integer nanoseconds (bigint). Every
     * clock-calibration offset the native layer computes/stores — and every
     * OWNER-APPLIED frame timestamp on a calibrated camera — is in THIS
     * domain. JS time code must delegate here instead of `hrtime.bigint()`
     * (not guaranteed the same Darwin clock domain): one authority only.
     */
    export function steadyNowNs(): bigint;

    export * as Aravis from "core/Aravis";
    export * as Controller from "core/Controller";
    export * as Vision from "core/Vision";
    export * as Tracker from "core/Tracker";
    export * as Regression from "core/Regression";
    export * as Geometry from "core/Geometry";
    export * as Compression from "core/Compression";
    export * as Log from "core/Log";
    export * as Shm from "core/Shm";
    export * as Pipe from "core/Pipe";
    export * as Topology from "core/Topology";
}
