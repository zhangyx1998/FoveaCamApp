// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { Point2d, Size, Rect as Rect } from "core/Geometry";

type Vector = Record<string, number>;

export const VEC = {
    add<T extends Vector, P extends Vector>(p: T, q: P): T & P {
        const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
        return Object.fromEntries(
            Array.from(keys).map((k) => [
                k,
                ((p as any)[k] ?? 0) + ((q as any)[k] ?? 0),
            ])
        ) as T & P;
    },
    sub<T extends Vector, P extends Vector>(p: T, q: P): T & P {
        const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
        return Object.fromEntries(
            Array.from(keys).map((k) => [
                k,
                ((p as any)[k] ?? 0) - ((q as any)[k] ?? 0),
            ])
        ) as T & P;
    },
    mul<T extends Vector>(p: T, k: number): T {
        return Object.fromEntries(
            Object.entries(p).map(([key, value]) => [key, value * k])
        ) as T;
    },
    div<T extends Vector>(p: T, k: number): T {
        return Object.fromEntries(
            Object.entries(p).map(([key, value]) => [key, value / k])
        ) as T;
    },
    dot<T extends Vector, P extends Vector>(p: T, q: P): T & P {
        const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
        return Object.fromEntries(
            Array.from(keys).map((k) => [
                k,
                ((p as any)[k] ?? 1) * ((q as any)[k] ?? 1),
            ])
        ) as T & P;
    },
};

export const RECT = Object.assign(
    function RECT({ x, y, width, height }: Rect): Rect {
        return { x, y, width, height };
    },
    {
        fromTopLeft(topLeft: Point2d, size: Size): Rect {
            return {
                x: topLeft.x,
                y: topLeft.y,
                width: size.width,
                height: size.height,
            };
        },
        fromCenter(center: Point2d, size: Size): Rect {
            return {
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height,
            };
        },
        getCenter(rect: Rect): Point2d {
            return {
                x: rect.x + rect.width / 2,
                y: rect.y + rect.height / 2,
            };
        },
        /**
         * Intersect a rect with the frame `[0, 0, width, height]`, rounding to
         * integer pixels. The result may be empty (zero/negative width/height)
         * when `rect` lies fully outside the frame — callers should check.
         */
        clampTo(rect: Rect, { width, height }: Size): Rect {
            const x = Math.max(0, Math.round(rect.x));
            const y = Math.max(0, Math.round(rect.y));
            const right = Math.min(width, Math.round(rect.x + rect.width));
            const bottom = Math.min(height, Math.round(rect.y + rect.height));
            return { x, y, width: right - x, height: bottom - y };
        },
        /**
         * @param rect Rect input
         * @param offset Offset distance, positive = expand, negative = shrink
         * @returns
         */
        offset(rect: Rect, offset: Partial<Point2d> | number): Rect {
            const { x = 0, y = 0 } =
                typeof offset === "number" ? { x: offset, y: offset } : offset;
            return {
                x: rect.x - x,
                y: rect.y - y,
                width: rect.width + 2 * x,
                height: rect.height + 2 * y,
            };
        },
    }
);
