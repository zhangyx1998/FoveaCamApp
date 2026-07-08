// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { TypedArray } from "core/types";
import type { Mat } from "core/Vision";

/** Independent copy of an 8-bit Mat — safe to retain past an `await` or across
 *  vision-worker ticks, unlike a reused SHM read buffer (overwritten on the next
 *  frame — see docs/history/refactor/orchestrator.md §3 "copy-before-await"). Used by the
 *  vision worker kernels when a derived Mat must outlive the frame it came from. */
export function copyMat<T extends Mat<Uint8Array>>(m: T): T {
  const data = new Uint8Array(m.buffer.slice(m.byteOffset, m.byteOffset + m.byteLength));
  return Object.assign(data, { shape: m.shape, channels: m.channels }) as unknown as T;
}

export function makeMat<T extends TypedArray>(
  arr: T,
  shape: number[],
  channels: number = 1,
): Mat<T> {
  return Object.assign(arr, { shape, channels }) as Mat<T>;
}

export function createMat<T extends TypedArray>(
  ctor: new (size: number) => T,
  shape: number[],
  channels: number = 1,
) {
  const size = shape.reduce((a, b) => a * b, channels);
  return makeMat(new ctor(size), shape, channels);
}

type NdArray<T> = NdArray<T>[] | T[];

export function matToArray(mat: Mat) {
  const { shape, channels } = mat;
  const s = [...shape];
  if (channels > 1) s.push(channels);
  function expand(offset: number, ch: number[]) {
    if (ch.length === 0) return mat[offset];
    const [d, ...remainder] = ch;
    const stride = remainder.reduce((a, b) => a * b, 1);
    const arr = new Array(d) as NdArray<number | bigint>;
    for (let i = 0; i < d; i++) {
      arr[i] = expand(offset + i * stride, remainder);
    }
    return arr;
  }
  return Object.assign(expand(0, s), { shape, channels });
}
