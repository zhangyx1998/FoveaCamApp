/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

import { ref, computed, markRaw } from "vue";

import Vector from "@lib/vector";

type CommandHandler = (data: Vector[], args: string[]) => void;

function optionalFlag(args: string[], ...flags: string[]): number {
  let count = 0;
  for (const flag of flags) {
    for (;;) {
      const index = args.indexOf(flag);
      if (index === -1) break;
      args.splice(index, 1);
      count += 1;
    }
  }
  return count;
}

function optionalRangeExp(args: string[], fallback = ":") {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.includes(":")) {
      args.splice(i, 1);
      return arg;
    }
  }
  return fallback;
}

function linspace(start: number, end: number, steps: number) {
  if (steps === 1) return [(start + end) / 2];
  const arr = new Array(steps);
  for (let i = 0; i < steps; i++) {
    arr[i] = start + (end - start) * (i / (steps - 1));
  }
  return arr;
}

function combinations<T>(ranges: T[][], zigzag: boolean = false) {
  const count = ranges.reduce((a, b) => a * b.length, 1);
  const arr = new Array(count);
  for (let i = 0; i < count; i++) {
    let index = i;
    const item = new Array(ranges.length) as T[];
    for (let j = 0; j < ranges.length; j++) {
      const range = ranges[j];
      const occurrence = Math.floor(
        i / ranges.slice(j + 1).reduce((a, b) => a * b.length, 1),
      );
      const idx = index % range.length;
      if (zigzag && occurrence % 2 === 1) item[j] = range.at(-idx - 1)!;
      else item[j] = range.at(idx)!;
      index = Math.floor(index / range.length);
    }
    arr[i] = item;
  }
  return arr;
}

class Selection {
  public readonly indexes: number[];
  constructor(
    sel: string,
    readonly points: Vector[],
  ) {
    this.indexes = sel
      .split(",")
      .map((s) => {
        if (!/-?\d*:-?\d*/.test(s)) throw new Error(`Invalid selection: ${s}`);
        if (!s.includes(":")) return [parseInt(s.trim())];
        let [l = 0, r = -1] = s.split(":").map((n) => parseInt(n.trim()));
        l = Math.max(0, l < 0 ? points.length + l : l);
        r = Math.min(points.length, r < 0 ? points.length + r : r);
        return new Array(r - l).fill(0).map((_, i) => l + i);
      })
      .flat()
      .filter((i) => i >= 0 && i < points.length);
  }
  *[Symbol.iterator]() {
    for (const i of this.indexes) yield [i, this.points[i]];
  }
  // In original order, no duplicates
  *selected() {
    for (const [i, p] of this.points.entries()) {
      if (this.indexes.includes(i)) yield p;
    }
  }
  *others() {
    for (const [i, p] of this.points.entries()) {
      if (!this.indexes.includes(i)) yield p;
    }
  }
  static from(points: Vector[], args: string[], fallback = ":") {
    const sel = optionalRangeExp(args, fallback);
    return new Selection(sel, points);
  }
}

const commands: Record<string, CommandHandler> = {
  delete(points: Vector[], args: string[]) {
    const sel = Selection.from(points, args, ":0");
    if (sel.indexes.length === 0) return; // nothing to delete
    points.length = 0;
    points.push(...sel.others());
  },
  add(points: Vector[], args: string[]) {
    const expand = optionalFlag(args, "...");
    const v = new Vector(args.map((a) => parseFloat(a))).validate();
    const dims = points.reduce((a, b) => Math.max(a, b.length), v.length);
    v.ensureDim(dims, expand ? (v[0] ?? 0.0) : 0.0);
    for (const [i, p] of points.entries()) points[i] = p.add(v);
  },
  sub(points: Vector[], args: string[]) {
    const expand = optionalFlag(args, "...");
    const v = new Vector(args.map((a) => parseFloat(a))).validate();
    const dims = points.reduce((a, b) => Math.max(a, b.length), v.length);
    v.ensureDim(dims, expand ? (v[0] ?? 0.0) : 0.0);
    for (const [i, p] of points.entries()) points[i] = p.sub(v);
  },
  mul(points: Vector[], args: string[]) {
    const expand = optionalFlag(args, "...");
    const v = new Vector(args.map((a) => parseFloat(a))).validate();
    const dims = points.reduce((a, b) => Math.max(a, b.length), v.length);
    v.ensureDim(dims, expand ? (v[0] ?? 1.0) : 1.0);
    for (const [i, p] of points.entries()) points[i] = p.mul(v);
  },
  div(points: Vector[], args: string[]) {
    const expand = optionalFlag(args, "...");
    const v = new Vector(args.map((a) => parseFloat(a))).validate();
    const dims = points.reduce((a, b) => Math.max(a, b.length), v.length);
    v.ensureDim(dims, expand ? (v[0] ?? 1.0) : 1.0);
    for (const [i, p] of points.entries()) points[i] = p.div(v);
  },
  reverse(points: Vector[], args: string[]) {
    points.reverse();
  },
  interpolate(points: Vector[], args: string[]) {
    const zigzag = optionalFlag(args, "zigzag") > 0;
    const expansions = args
      .map((arg) => parseInt(arg))
      .filter((n) => !isNaN(n));
    if (expansions.length === 0) return; // nothing to interpolate
    if (expansions.some((n) => n < 1))
      throw new Error("Interpolation expansion must be a positive integer");
    const corner_count = Math.pow(2, expansions.length);
    if (points.length < corner_count)
      throw new Error(
        `Not enough points for interpolation: expected at least ${corner_count}, got ${points.length}`,
      );
    // Take last 2^n points as corners, remove them from original points
    const corners = points.splice(-corner_count, corner_count);
    const dims = Math.max(...corners.map((p) => p.length));
    // bilinear interpolation
    const ranges = expansions.map((n) => linspace(0, 1, n));
    const combos = combinations(ranges, zigzag);
    for (const weights of combos) {
      let c = [...corners];
      for (const w of weights) {
        const next: Vector[] = [];
        for (let i = 0; i < c.length; i += 2) {
          const p1 = c[i];
          const p2 = c[i + 1];
          const p = new Vector(...Array(dims).fill(0));
          for (let d = 0; d < dims; d++) {
            const v1 = p1[d] ?? 0;
            const v2 = p2[d] ?? 0;
            p[d] = v1 * (1 - w) + v2 * w;
          }
          next.push(p);
        }
        c = next;
      }
      if (c.length !== 1) throw new Error("Interpolation failed");
      points.push(c[0]);
    }
  },
};

interface RefLike<T> {
  value: T;
}

export default class SetPoints {
  constructor(initial: string | RefLike<string> = "") {
    if (typeof initial === "string") {
      this.#raw = ref(initial);
    } else {
      this.#raw = initial;
    }
  }
  #raw: RefLike<string>;
  get raw() {
    return this.#raw.value;
  }
  set raw(value: string) {
    this.#raw.value = value;
  }

  private get lines() {
    return this.raw
      .split("\n")
      .map((l) => l.split("#")[0].trim())
      .filter(Boolean);
  }

  private build() {
    const points = new Array<Vector>();
    for (const line of this.lines) {
      if (line.startsWith("@")) {
        const [cmd, ...args] = line.slice(1).split(/\s+/);
        const handler = commands[cmd!];
        if (handler) {
          handler(points, args);
        } else {
          throw new Error(`Unknown command: ${cmd}`);
        }
      } else {
        // Parse vector
        const values = line
          .split(/\s*[,\s]\s*/)
          .map((s) => parseFloat(s.trim()));
        if (values.some((v) => isNaN(v)))
          throw new Error(`Invalid vector: ${line}`);
        points.push(markRaw(new Vector(values)));
      }
    }
    // make all points equal dimension
    const dims = points.reduce((a, b) => Math.max(a, b.length), 0);
    for (const d of points) {
      while (d.length < dims) d.push(0);
    }
    return points;
  }

  append(point: Vector) {
    let line = point.join(", ") + "\n";
    if (this.raw && !this.raw.endsWith("\n")) line = "\n" + line;
    this.raw += line;
  }

  #output = computed(() => {
    try {
      return this.build();
    } catch (e) {
      if (e instanceof Error) return e;
      else return new Error(String(e));
    }
  });

  get output() {
    return this.#output.value;
  }

  [Symbol.iterator]() {
    const { output } = this;
    if (output instanceof Error) {
      return [][Symbol.iterator]();
    } else {
      return output[Symbol.iterator]();
    }
  }
}
