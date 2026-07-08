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

    export * as Aravis from "core/Aravis";
    export * as Controller from "core/Controller";
    export * as Vision from "core/Vision";
    export * as Regression from "core/Regression";
    export * as Log from "core/Log";
    export * as Shm from "core/Shm";
    export * as Pipe from "core/Pipe";
}
