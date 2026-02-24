// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------


interface Vector extends Sequence<number> {
  reduce<U>(
    callback: (
      previousValue: U,
      currentValue: number,
      currentIndex: number,
      array: Vector,
    ) => U,
    initialValue: U,
  ): U;
}

export function max(values: Vector) {
  return values.reduce((a, b) => Math.max(a, b), -Infinity);
}

export function min(values: Vector) {
  return values.reduce((a, b) => Math.min(a, b), Infinity);
}

export function sum(values: Vector) {
  return values.reduce((a, b) => a + b, 0);
}

export function avg(values: Vector) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

export function std(values: Vector) {
  if (values.length === 0) return 0;
  const mean = avg(values);
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function diff(values: Vector) {
  if (values.length === 0) return 0;
  return max(values) - min(values);
}

export function rad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function deg(rad: number) {
  return (rad * 180) / Math.PI;
}

export function distance2D(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
) {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}
