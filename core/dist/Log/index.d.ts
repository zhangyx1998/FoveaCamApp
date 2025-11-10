// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
declare module "core/Log" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    export function error(...args: any[]): void;
    export function warn(...args: any[]): void;
    export function info(...args: any[]): void;
    export function verbose(...args: any[]): void;
}
