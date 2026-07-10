// Pure patch-protocol helpers (config-store-main-authority.md): the renderer
// diffs its tracked doc against the last main-acked value (`diffKeys`) and main
// merges the ops (`applyOps`). `deepEqual` decides whether a top-level key
// actually changed so a no-op edit produces NO patch. No Vue/Electron/fs here.

import { describe, expect, it } from "vitest";
import {
  applyOps,
  deepEqual,
  diffKeys,
  replaceInPlace,
  type PatchOp,
} from "@lib/store-patch";

describe("diffKeys", () => {
  it("emits a set op for an added key", () => {
    expect(diffKeys({ a: 1, b: 2 }, { a: 1 })).toEqual([{ key: "b", value: 2 }]);
  });

  it("emits a set op for a changed key (whole value at top-level granularity)", () => {
    expect(diffKeys({ a: { x: 2 } }, { a: { x: 1 } })).toEqual([
      { key: "a", value: { x: 2 } },
    ]);
  });

  it("emits a remove op for a deleted key", () => {
    expect(diffKeys({ a: 1 }, { a: 1, b: 2 })).toEqual([{ key: "b", remove: true }]);
  });

  it("produces NO patch for a no-op (deep-equal doc)", () => {
    expect(diffKeys({ a: 1, nested: { x: [1, 2] } }, { a: 1, nested: { x: [1, 2] } })).toEqual(
      [],
    );
  });

  it("mixes set + remove across keys", () => {
    const ops = diffKeys({ a: 1, c: 3 }, { a: 0, b: 2 });
    expect(ops).toContainEqual({ key: "a", value: 1 });
    expect(ops).toContainEqual({ key: "c", value: 3 });
    expect(ops).toContainEqual({ key: "b", remove: true });
    expect(ops).toHaveLength(3);
  });

  it("falls back to a whole-doc replace for arrays", () => {
    expect(diffKeys([1, 2, 3], [1, 2])).toEqual([{ replace: [1, 2, 3] }]);
    expect(diffKeys([1, 2], [1, 2])).toEqual([]);
  });
});

describe("applyOps", () => {
  it("sets and deletes top-level keys without mutating the input", () => {
    const current = { a: 1, b: 2 };
    const ops: PatchOp[] = [{ key: "a", value: 9 }, { key: "b", remove: true }, { key: "c", value: 3 }];
    const next = applyOps(current, ops) as Record<string, unknown>;
    expect(next).toEqual({ a: 9, c: 3 });
    expect(current).toEqual({ a: 1, b: 2 }); // untouched
  });

  it("round-trips a diff: applyOps(prev, diffKeys(next, prev)) === next", () => {
    const prev = { a: 1, b: { x: 1 }, drop: true };
    const next = { a: 2, b: { x: 2 }, added: 5 };
    expect(applyOps(prev, diffKeys(next, prev))).toEqual(next);
  });

  it("applies a whole-doc replace", () => {
    expect(applyOps({ a: 1 }, [{ replace: [7, 8] }])).toEqual([7, 8]);
  });
});

describe("deepEqual", () => {
  it("compares primitives, bigint, Date, and TypedArray by value", () => {
    expect(deepEqual(1n, 1n)).toBe(true);
    expect(deepEqual(1n, 2n)).toBe(false);
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
  });

  it("distinguishes shapes and nesting", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("replaceInPlace", () => {
  it("reconciles keys WITHOUT replacing the object reference", () => {
    const target: Record<string, unknown> = { a: 1, gone: true };
    const ref = target;
    replaceInPlace(target, { a: 2, b: 3 });
    expect(ref).toBe(target);
    expect(target).toEqual({ a: 2, b: 3 });
  });

  it("clears keys when the incoming value is undefined (clear echo)", () => {
    const target: Record<string, unknown> = { a: 1 };
    replaceInPlace(target, undefined);
    expect(target).toEqual({});
  });

  it("reconciles arrays in place", () => {
    const target = [1, 2, 3];
    replaceInPlace(target, [4, 5]);
    expect(target).toEqual([4, 5]);
  });
});
