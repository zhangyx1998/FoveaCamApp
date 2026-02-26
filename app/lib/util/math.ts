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

type ScaleLevel = { level: number; name: string };

export class Scale {
  private readonly levels: ScaleLevel[];
  private readonly level_shift: number;
  constructor(levels: ScaleLevel[], level_shift = 1.0) {
    // Descending sort by level
    levels.sort((a, b) => b.level - a.level);
    this.levels = levels;
    this.level_shift = level_shift;
  }
  evaluate(value: number, precision = 2) {
    value *= this.level_shift;
    for (const [i, { level, name }] of this.levels.entries()) {
      if (
        Math.abs(value) >= level ||
        i === this.levels.length - 1 ||
        (value === 0 && level <= this.level_shift)
      )
        return { value: (value / level).toFixed(precision), scale: name };
    }
    throw new Error("Invalid scale configuration");
  }
  static pm(v: number, precision = 2, unit?: string | Scale | undefined) {
    const s = Scale.use(unit);
    const { value, scale } = s.evaluate(Math.abs(v), precision);
    const sign = ["-", " ", "+"][Math.sign(v) + 1];
    return (
      sign + value.padStart(3 + 1 + precision, " ") + scale + (scale ? "" : " ")
    );
  }
  static use(scale: Scale | string | undefined) {
    if (scale instanceof Scale) return scale;
    return Scale.plain(scale ?? "");
  }
  static create(name: string, level_shift: number = 1.0) {
    return new Scale(
      [
        { level: 1e12, name: "T" + name },
        { level: 1e9, name: "G" + name },
        { level: 1e6, name: "M" + name },
        { level: 1e3, name: "K" + name },
        { level: 1, name },
        { level: 1e-3, name: "m" + name },
        { level: 1e-6, name: "μ" + name },
        { level: 1e-9, name: "n" + name },
        { level: 1e-12, name: "p" + name },
      ],
      level_shift,
    );
  }
  static plain(name: string, level_shift: number = 1.0) {
    return new Scale([{ level: 1, name }], level_shift);
  }
  static readonly meters = Scale.create("m");
  static readonly millimeters = Scale.create("m", 1e-3);
  static readonly seconds = Scale.create("s");
  static readonly milliseconds = Scale.create("ms", 1e-3);
  static readonly hertz = Scale.create("Hz");
  static readonly bytes = Scale.create("B");
  static readonly bits = Scale.create("b");
  static readonly degrees = Scale.plain("°");
  static readonly none = Scale.plain("");
}
