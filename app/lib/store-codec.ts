// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// On-disk codec for the config store: JSON `replacer`/`reviver` that round-trip
// bigint, Date, ArrayBuffer and TypedArrays (with their attached props, e.g. a
// Mat's `shape`/`channels`) via base64. Extracted so both the renderer `Store`
// and the orchestrator store read/write byte-compatible files — keep this
// dependency-free (no Vue/Electron) so it loads in any process.

import { TypedArray } from "core/types";

const TypedArrayConstructors = {
  Uint8Array,
  Uint8ClampedArray,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

function ownProperties(value: any) {
  let flag = false;
  const result: Record<string, any> = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    // Skip numeric indices (array-like indexed properties)
    if (/^\d+$/.test(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Only include writable, enumerable properties that were assigned
    if (descriptor && descriptor.writable && descriptor.enumerable) {
      result[key] = (value as any)[key];
      flag = true;
    }
  }
  return flag ? result : undefined;
}

function toBase64(buffer: ArrayBufferLike): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(str: string): ArrayBuffer {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

type Deflated<T = {}> = T & {
  type: string;
  props?: Record<string, any>;
};

export function replacer(key: string, value: any) {
  if (typeof value === "bigint") {
    return {
      type: "bigint",
      value: value.toString(),
    };
  }
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) {
    return {
      type: "Date",
      date: value.toISOString(),
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: "ArrayBuffer",
      buffer: toBase64(value),
      props: ownProperties(value),
    };
  }
  for (const [k, c] of Object.entries(TypedArrayConstructors)) {
    if (value instanceof c) {
      return {
        type: k,
        buffer: toBase64((value as TypedArray).buffer),
        props: ownProperties(value),
      };
    }
  }
  return value;
}

export function reviver(key: string, value: any) {
  if (typeof value !== "object" || value === null) return value;
  const { type, props = {} } = value as Deflated;
  if (type === "bigint") {
    const { value: val } = value as Deflated<{ value: string }>;
    return BigInt(val);
  }
  if (type === "Date") {
    const { date } = value as Deflated<{ date: string }>;
    return new Date(date);
  }
  if (type === "ArrayBuffer") {
    const { buffer } = value as Deflated<{ buffer: string }>;
    const arr = fromBase64(buffer);
    Object.assign(arr, props);
    return arr;
  }
  if (type in TypedArrayConstructors) {
    const ctor = (TypedArrayConstructors as any)[type];
    const { buffer } = value as Deflated<{ buffer: string }>;
    const arr = new ctor(fromBase64(buffer));
    Object.assign(arr, props);
    return arr;
  }
  return value;
}
