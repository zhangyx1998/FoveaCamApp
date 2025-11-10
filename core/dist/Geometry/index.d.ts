// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

declare module "core/Geometry" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    export type Size<T = number> = { width: T; height: T };
    export type Point3d<T = number> = { x: T; y: T; z: T };
    export type Point2d<T = number> = { x: T; y: T };
    export type Point = Point2d;
    export type Rect = Point2d & Size;
}
