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
