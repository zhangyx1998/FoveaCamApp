// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export function sum(...args: number[]) {
    return args.reduce((a, b) => a + b, 0);
}

export function avg(...args: number[]) {
    if (args.length === 0) return 0;
    return sum(...args) / args.length;
}

export function diff(...args: number[]) {
    if (args.length === 0) return 0;
    return Math.max(...args) - Math.min(...args);
}

export function rad(deg: number) {
    return (deg * Math.PI) / 180;
}

export function deg(rad: number) {
    return (rad * 180) / Math.PI;
}

export function distance2D(
    p1: { x: number; y: number },
    p2: { x: number; y: number }
) {
    return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}
