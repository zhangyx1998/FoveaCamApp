// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export function signedNumber(val: number, sign_zero: string = "") {
    const result = Math.abs(val).toString();
    return ["-", sign_zero, "+"][Math.sign(val) + 1] + result;
}

export function parseIntStrict(s: string, radix?: number) {
    if (!/^[+-]?\d+$/.test(s.trim())) return null;
    const result = parseInt(s, radix);
    if (isNaN(result)) return null;
    return result;
}

export function parseFloatStrict(s: string) {
    if (!/^[+-]?\d+(\.\d+)?$/.test(s.trim())) return null;
    const result = parseFloat(s);
    if (isNaN(result)) return null;
    return result;
}

export function camel2dash(s: string) {
    return s.replace(/([A-Z])/g, (m) => "-" + m.toLowerCase());
}

export function dash2camel(s: string) {
    return s.replace(/-([a-z])/g, (_, g) => g.toUpperCase());
}
