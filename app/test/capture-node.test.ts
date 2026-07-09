// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Unit tests for the capture-node PURE parts (capture-recorder-nodes Phase 3):
// the burst-grab seq loop, the indexed-resource accumulation state machine, the
// manifest shape, the center rect clamp, and the downconvert selection. These
// are the exact functions the worker embeds via `.toString()`, so covering them
// here covers the production worker's logic without loading native core.

import { describe, it, expect } from "vitest";
import {
  grabBurst,
  accumulate,
  manifestOf,
  clampRect,
  needsDownconvert,
  type BurstCfg,
} from "@orchestrator/capture-node";
import type { SeqRead } from "@orchestrator/recorder-node";

const nextTick = () => Promise.resolve();

/** A scripted FIFO reader: `script[i]` is returned for the i-th `read()` call
 *  (regardless of `wantSeq`), letting a test drive the exact classification
 *  sequence (torn/notYet/gone/ok/closed). */
function scriptedBurst(
  script: SeqRead[],
  overrides: Partial<BurstCfg> = {},
): { cfg: BurstCfg; frames: bigint[]; drops: number[] } {
  const frames: bigint[] = [];
  const drops: number[] = [];
  let i = 0;
  const cfg: BurstCfg = {
    dst: new Uint8Array(16),
    startSeq: 1n,
    count: 3,
    bytesFor: () => 4,
    read: () => (i < script.length ? script[i++]! : { closed: true }),
    onFrame: (_view, seq) => frames.push(seq),
    onDrop: (n) => drops.push(n),
    delay: () => nextTick(),
    ...overrides,
  };
  return { cfg, frames, drops };
}

const ok = (seq: number): SeqRead => ({ seq: BigInt(seq), width: 2, height: 1 });

describe("grabBurst", () => {
  it("grabs exactly `count` consecutive fresh frames", async () => {
    const { cfg, frames } = scriptedBurst([ok(1), ok(2), ok(3), ok(4)]);
    const got = await grabBurst(cfg);
    expect(got).toBe(3);
    expect(frames).toEqual([1n, 2n, 3n]); // stops at count, never reads the 4th
  });

  it("retries the same seq on a torn read and backs off on NotYet", async () => {
    let delays = 0;
    const { cfg, frames } = scriptedBurst(
      [null, { notYet: true }, ok(1), ok(2), ok(3)],
      { delay: () => { delays++; return nextTick(); } },
    );
    const got = await grabBurst(cfg);
    expect(got).toBe(3);
    expect(frames).toEqual([1n, 2n, 3n]);
    expect(delays).toBe(1); // one NotYet backoff; the torn read did not delay
  });

  it("accounts a Gone gap and jumps forward", async () => {
    // want starts at 1; a Gone(oldest=5) accounts 4 drops and jumps to 5.
    const { cfg, frames, drops } = scriptedBurst([
      { gone: true, oldestSeq: 5n },
      ok(5),
      ok(6),
      ok(7),
    ]);
    const got = await grabBurst(cfg);
    expect(got).toBe(3);
    expect(drops).toEqual([4]);
    expect(frames).toEqual([5n, 6n, 7n]);
  });

  it("returns short when the producer retires mid-burst", async () => {
    const { cfg, frames } = scriptedBurst([ok(1), { closed: true }]);
    const got = await grabBurst(cfg);
    expect(got).toBe(1);
    expect(frames).toEqual([1n]);
  });

  it("delivers the active-byte view sized by bytesFor", async () => {
    const seen: number[] = [];
    const { cfg } = scriptedBurst([ok(1)], {
      count: 1,
      bytesFor: (w, h) => w * h * 3,
      onFrame: (view) => seen.push(view.byteLength),
    });
    await grabBurst(cfg);
    expect(seen).toEqual([2 * 1 * 3]);
  });
});

describe("accumulate / manifestOf", () => {
  type E = { meta?: unknown; image?: string };

  it("unindexed replaces (a 1-shot resource / once-captured wide)", () => {
    const store = new Map<string, E | E[]>();
    expect(accumulate(store, "wide", { meta: { a: 1 } }, false)).toBe(-1);
    accumulate(store, "wide", { meta: { a: 2 } }, false); // replaces
    expect(store.get("wide")).toEqual({ meta: { a: 2 } });
  });

  it("indexed accumulates an array in call order, returning the index", () => {
    const store = new Map<string, E | E[]>();
    expect(accumulate(store, "left", { image: "L0" }, true)).toBe(0);
    expect(accumulate(store, "left", { image: "L1" }, true)).toBe(1);
    expect(accumulate(store, "left", { image: "L2" }, true)).toBe(2);
    expect(store.get("left")).toEqual([{ image: "L0" }, { image: "L1" }, { image: "L2" }]);
  });

  it("builds the manifest: meta-or-null, arrays for indexed resources", () => {
    const store = new Map<string, E | E[]>();
    accumulate(store, "wide", { meta: { sensor: 1 } }, false);
    accumulate(store, "center", { image: "C0" }, true); // image-only → null meta
    accumulate(store, "left", { image: "L0", meta: { volt: 5 } }, true);
    accumulate(store, "left", { image: "L1", meta: { volt: 6 } }, true);
    const manifest = manifestOf(store, (e) => (e.meta !== undefined ? (e.meta as never) : null));
    expect(manifest).toEqual({
      wide: { sensor: 1 },
      center: [null],
      left: [{ volt: 5 }, { volt: 6 }],
    });
    // Insertion order preserved (wide, center, left).
    expect(Object.keys(manifest)).toEqual(["wide", "center", "left"]);
  });
});

describe("clampRect", () => {
  it("rounds, clamps into W×H, and keeps a min 1×1", () => {
    expect(clampRect({ x: -5, y: -5, width: 4, height: 4 }, 10, 10)).toEqual({
      x: 0, y: 0, width: 4, height: 4,
    });
    expect(clampRect({ x: 8, y: 8, width: 9, height: 9 }, 10, 10)).toEqual({
      x: 8, y: 8, width: 2, height: 2,
    });
    expect(clampRect({ x: 20, y: 20, width: 1, height: 1 }, 10, 10)).toEqual({
      x: 9, y: 9, width: 1, height: 1,
    });
  });
});

describe("needsDownconvert", () => {
  it("passes 8-bit through, downconverts full-depth (mirrors publishFrame)", () => {
    expect(needsDownconvert(1)).toBe(false); // sliced center (Uint8Array)
    expect(needsDownconvert(2)).toBe(true); // 16-bit fovea / diff
  });
});
