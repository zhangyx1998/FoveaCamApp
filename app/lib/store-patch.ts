// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure diff/merge helpers for the config-store patch protocol
// (docs/proposals/config-store-main-authority.md). The renderer `Store` client
// diffs its tracked reactive document against the last value it knows main has
// (`diffKeys`) and sends the resulting top-level-key ops; main merges them into
// the authoritative document (`applyOps`). Both halves are transport-free and
// unit-tested — no Vue, no Electron, no fs. `deepEqual` handles the value shapes
// that cross the structured-clone / store-codec boundary (bigint, Date,
// TypedArray) so a no-op edit produces NO patch.

/** One top-level-key patch operation, or a whole-document replace. A nested
 *  change is expressed as a whole `{ key, value }` replace of that top-level
 *  key — that is the granularity of the protocol. `{ replace }` is emitted only
 *  when the document is an array / non-plain-object (arrays are not the
 *  multi-writer race case; a whole replace keeps their semantics simple). */
export type PatchOp =
  | { key: string; value: unknown }
  | { key: string; remove: true }
  | { replace: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Structural equality across the value shapes config docs carry (primitives,
 *  plain objects, arrays, Date, bigint, TypedArray/ArrayBuffer). Used purely to
 *  decide whether a top-level key actually changed — a false "changed" only
 *  costs a redundant patch op, never correctness. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    const ua = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    if (ua.byteLength !== ub.byteLength) return false;
    for (let i = 0; i < ua.byteLength; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
}

/** Diff `next` against `prev` at top-level-key granularity, returning the ops
 *  that transform `prev` into `next`. Returns `[]` for a no-op. For an
 *  array / non-plain-object document (either side), emits a single whole-doc
 *  `{ replace }` when they differ. */
export function diffKeys(next: unknown, prev: unknown): PatchOp[] {
  if (!isPlainObject(next) || !isPlainObject(prev))
    return deepEqual(next, prev) ? [] : [{ replace: next }];
  const ops: PatchOp[] = [];
  for (const k of Object.keys(next))
    if (!(k in prev) || !deepEqual(next[k], prev[k])) ops.push({ key: k, value: next[k] });
  for (const k of Object.keys(prev)) if (!(k in next)) ops.push({ key: k, remove: true });
  return ops;
}

/** Apply patch ops onto `current`, returning the new document value WITHOUT
 *  mutating `current` (shallow copy-on-write). A `{ replace }` op resets the
 *  whole value; key ops set/delete a top-level key. */
export function applyOps(current: unknown, ops: readonly PatchOp[]): unknown {
  let base: unknown = isPlainObject(current) ? { ...current } : current;
  for (const op of ops) {
    if ("replace" in op) {
      base = op.replace;
      continue;
    }
    if (!isPlainObject(base)) base = {};
    if ("remove" in op) delete (base as Record<string, unknown>)[op.key];
    else (base as Record<string, unknown>)[op.key] = op.value;
  }
  return base;
}

/** Reconcile `target`'s keys/values to match `value` WITHOUT replacing the
 *  object reference — callers (templates, computed) hold onto `target` directly.
 *  Moved here from the renderer `Store` so it is unit-testable in isolation. */
export function replaceInPlace(target: any, value: any): void {
  if (Array.isArray(target) && Array.isArray(value)) {
    target.length = 0;
    target.push(...value);
    return;
  }
  if (value === undefined || value === null) {
    for (const k of Object.keys(target)) delete target[k];
    return;
  }
  for (const k of Object.keys(target)) if (!(k in value)) delete target[k];
  Object.assign(target, value);
}
