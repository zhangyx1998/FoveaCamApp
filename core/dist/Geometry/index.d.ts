// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { Mat } from "core/Vision";
import { TypedArray } from "../types";

declare module "core/Geometry" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    export type Size<T = number> = { width: T; height: T };
    export type Point3d<T = number> = { x: T; y: T; z: T };
    export type Point2d<T = number> = { x: T; y: T };
    export type Point = Point2d;
    export type Rect = Point2d & Size;

    export function identity(n: number): Mat<Float64Array>;
    export function transpose<T extends TypedArray>(mat: Mat<T>): Mat<T>;
    export function matMul<T extends TypedArray>(
        A: Mat<T>,
        ...mats: Mat<T>[]
    ): Mat<T>;
    export function rotateX(angle: number): Mat<Float64Array>;
    export function rotateY(angle: number): Mat<Float64Array>;
    export function rotateZ(angle: number): Mat<Float64Array>;
    export function translate(p: Point3d): Mat<Float64Array>;
    export function transform<T extends TypedArray>(
        transformMatrix: Mat<T>,
        points: Point3d[]
    ): Point3d[];
    export function area(contour: Point2d[]): number;
}
