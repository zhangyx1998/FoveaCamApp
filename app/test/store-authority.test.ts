// The MAIN config-store authority core (config-store-main-authority.md): the
// cache + per-doc serialized queue + notify-except-origin engine, lifted out of
// the old orchestrator store-hub. These are the read/write/update/clear/echo-
// skip/serialization semantics the retired `store-hub.test.ts` covered, now
// exercised against the authority directly with an in-memory fs, PLUS the new
// key-level `patch` (two writers to DIFFERENT keys both survive).

import { describe, expect, it, vi } from "vitest";
import { createStoreAuthority, type StoreFsBackend } from "@lib/store-authority";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((r) => (this.resolve = r));
  }
}

function memFs(): StoreFsBackend & { disk: Map<string, unknown> } {
  const disk = new Map<string, unknown>();
  const key = (s: string[]) => s.join("/");
  return {
    disk,
    read: async <T>(s: string[], fb: T) =>
      (disk.has(key(s)) ? structuredClone(disk.get(key(s))) : fb) as T,
    write: async (s, v) => void disk.set(key(s), structuredClone(v)),
    clear: async (s) => void disk.delete(key(s)),
    list: async () => [],
  };
}

describe("store authority", () => {
  it("read() returns the fs fallback on first access, cached after", async () => {
    const a = createStoreAuthority(memFs());
    expect(await a.read(["cfg"], { x: 1 })).toEqual({ x: 1 });
  });

  it("read() returns the persisted value once written", async () => {
    const a = createStoreAuthority(memFs());
    await a.write(["cfg"], { x: 2 });
    expect(await a.read(["cfg"], { x: 0 })).toEqual({ x: 2 });
  });

  it("update() merges a patch (read-modify-write)", async () => {
    const a = createStoreAuthority(memFs());
    await a.write(["cfg"], { x: 1, y: 1 });
    await a.update(["cfg"], { y: 2 });
    expect(await a.read(["cfg"], {})).toEqual({ x: 1, y: 2 });
  });

  it("patch() sets and deletes top-level keys", async () => {
    const a = createStoreAuthority(memFs());
    await a.write(["cfg"], { x: 1, drop: true });
    await a.patch(["cfg"], [{ key: "y", value: 2 }, { key: "drop", remove: true }]);
    expect(await a.read(["cfg"], {})).toEqual({ x: 1, y: 2 });
  });

  it("clear() removes the value; a later read falls back again", async () => {
    const a = createStoreAuthority(memFs());
    await a.write(["cfg"], { x: 1 });
    await a.clear(["cfg"]);
    expect(await a.read(["cfg"], { fallback: true })).toEqual({ fallback: true });
  });

  it("echo-skip: an originator is not notified of its own write", async () => {
    const a = createStoreAuthority(memFs());
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const lisA = (v: unknown) => seenA.push(v);
    const lisB = (v: unknown) => seenB.push(v);
    a.subscribe(["cfg"], lisA);
    a.subscribe(["cfg"], lisB);
    await a.write(["cfg"], { x: 42 }, lisA); // A is the origin
    expect(seenB).toEqual([{ x: 42 }]);
    expect(seenA).toEqual([]);
  });

  it("two clients patching DIFFERENT keys BOTH survive (D4 fix)", async () => {
    const fs = memFs();
    const a = createStoreAuthority(fs);
    const lisA = vi.fn();
    const lisB = vi.fn();
    a.subscribe(["cfg"], lisA);
    a.subscribe(["cfg"], lisB);
    // Concurrent, each excepting its own listener (as StoreMain does per client).
    await Promise.all([
      a.patch(["cfg"], [{ key: "a", value: 1 }], lisA),
      a.patch(["cfg"], [{ key: "b", value: 2 }], lisB),
    ]);
    expect(await a.read(["cfg"], {})).toEqual({ a: 1, b: 2 });
    expect(fs.disk.get("cfg")).toEqual({ a: 1, b: 2 });
    // Each peer saw the OTHER's write, never its own (echo-skip). A's patch runs
    // first (enqueue order): B sees {a:1}; then B's patch: A sees the merge.
    expect(lisB).toHaveBeenCalledWith({ a: 1 });
    expect(lisA).toHaveBeenCalledWith({ a: 1, b: 2 });
  });

  it("same-key concurrent writes are last-write-wins", async () => {
    const a = createStoreAuthority(memFs());
    await Promise.all([
      a.patch(["cfg"], [{ key: "k", value: "first" }]),
      a.patch(["cfg"], [{ key: "k", value: "second" }]),
    ]);
    expect(await a.read(["cfg"], {})).toEqual({ k: "second" });
  });

  it("serializes writes so broadcasts reflect committed values in order", async () => {
    const fs = memFs();
    const gate = new Deferred<void>();
    const realWrite = fs.write;
    let first = true;
    fs.write = async (s, v) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return realWrite(s, v);
    };
    const a = createStoreAuthority(fs);
    const seen: unknown[] = [];
    a.subscribe(["cfg"], (v) => seen.push(v));

    const w1 = a.write(["cfg"], { n: 1 });
    const w2 = a.write(["cfg"], { n: 2 });
    await Promise.resolve();
    expect(seen).toEqual([]); // nothing committed while the first write is gated

    gate.resolve();
    await Promise.all([w1, w2]);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fs.disk.get("cfg")).toEqual({ n: 2 });
  });

  it("counts() accumulates write/update/clear activity", async () => {
    const a = createStoreAuthority(memFs());
    await a.write(["cfg"], {});
    await a.update(["cfg"], { a: 1 });
    await a.clear(["cfg"]);
    expect(a.counts()).toEqual({ writes: 1, updates: 1, clears: 1 });
  });
});
