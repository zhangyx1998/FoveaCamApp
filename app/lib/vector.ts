/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

export default class Vector extends Array<number> {
  constructor(length?: number, fill?: number);
  constructor(values: Iterable<number>);
  constructor(arg: number | Iterable<number> = 0, fill: number = 0) {
    if (typeof arg === "number") {
      super(arg);
      this.fill(fill);
    } else {
      return Object.setPrototypeOf([...arg], Vector.prototype);
    }
  }

  validate() {
    if (!this.every((v) => typeof v === "number" && isFinite(v)))
      throw new TypeError("All elements of a Vector must be finite numbers.");
    return this;
  }

  get dim() {
    return this.length;
  }

  ensureDim(dim: number = this.dim, fill = 0) {
    while (this.dim < dim) this.push(fill);
  }

  *broadcast<T>(other: Vector, fn: (a: number, b: number) => T) {
    const dim = Math.max(this.length, other.length);
    for (let i = 0; i < dim; i++) yield fn(this.at(i) ?? 0, other.at(i) ?? 0);
  }

  add(other: Vector) {
    return new Vector(this.broadcast(other, (a, b) => a + b));
  }

  static add(...vectors: Vector[]) {
    if (vectors.length === 0) return new Vector();
    return vectors.reduce((a, b) => a.add(b));
  }

  sub(other: Vector) {
    return new Vector(this.broadcast(other, (a, b) => a - b));
  }

  static sub(...vectors: Vector[]) {
    if (vectors.length === 0) return new Vector();
    return vectors.reduce((a, b) => a.sub(b));
  }

  mul(other: Vector) {
    return new Vector(this.broadcast(other, (a, b) => a * b));
  }

  static mul(...vectors: Vector[]) {
    if (vectors.length === 0) return new Vector();
    return vectors.reduce((a, b) => a.mul(b));
  }

  div(other: Vector) {
    return new Vector(this.broadcast(other, (a, b) => a / b));
  }

  static div(...vectors: Vector[]) {
    if (vectors.length === 0) return new Vector();
    return vectors.reduce((a, b) => a.div(b));
  }

  dot(other: Vector) {
    return this.mul(other).sum;
  }

  static dot(a: Vector, b: Vector) {
    return a.dot(b);
  }

  get sum() {
    return this.reduce((a, b) => a + b, 0);
  }

  get norm() {
    return Math.hypot(...this);
  }
}
