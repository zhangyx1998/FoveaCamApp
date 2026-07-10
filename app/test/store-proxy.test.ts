// The orchestrator/probe-side store proxy talking to the MAIN authority over a
// fake parentPort link to `StoreMain.attachProcess` (config-store-main-authority.md).
// Covers: a child's read/write persists in main; a write from ONE child fires
// another child's live `subscribe()` (the cross-instance broadcast that fixes
// D1); an originator is not double-notified; and the decay regression — after a
// child "instance" drops, a FRESH child still reads/writes the same authoritative
// doc (a store connection never dies with an instance).

import { describe, expect, it, vi } from "vitest";
import { StoreMain } from "../electron/store-main";
import { createStoreProxy, type StoreProxyTransport } from "@lib/store-proxy";
import type { StoreFsBackend } from "@lib/store-authority";

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

/** Connect a fresh proxy "child instance" to a StoreMain via an in-memory link. */
function connectChild(main: StoreMain) {
  let deliver: (msg: any) => void = () => {};
  const link = main.attachProcess((msg) => deliver(msg));
  const transport: StoreProxyTransport = {
    post: (msg) => link.handleMessage(msg),
    onMessage: (cb) => {
      deliver = cb as (msg: any) => void;
    },
  };
  return { proxy: createStoreProxy(transport), detach: link.detach };
}

describe("store proxy ↔ main authority", () => {
  it("read/write round-trips through the main authority", async () => {
    const fs = memFs();
    const main = new StoreMain(() => {}, fs);
    const { proxy } = connectChild(main);
    expect(await proxy.read(["cfg"], { x: 0 })).toEqual({ x: 0 });
    await proxy.write(["cfg"], { x: 7 });
    expect(fs.disk.get("cfg")).toEqual({ x: 7 });
    expect(await proxy.read(["cfg"], {})).toEqual({ x: 7 });
  });

  it("a write on one instance fires another instance's live subscribe (cross-instance)", async () => {
    const main = new StoreMain(() => {}, memFs());
    const a = connectChild(main);
    const b = connectChild(main);
    const seenA = vi.fn();
    const seenB = vi.fn();
    a.proxy.subscribe(["cfg"], seenA);
    b.proxy.subscribe(["cfg"], seenB);

    await a.proxy.write(["cfg"], { anaglyph_style: "BC" });

    // B (a different instance) sees the edit live; A sees it exactly once
    // (locally, from its own write) with NO double from a main echo.
    expect(seenB).toHaveBeenCalledTimes(1);
    expect(seenB).toHaveBeenCalledWith({ anaglyph_style: "BC" });
    expect(seenA).toHaveBeenCalledTimes(1);
    expect(seenA).toHaveBeenCalledWith({ anaglyph_style: "BC" });
  });

  it("update() merges and broadcasts the merged doc", async () => {
    const main = new StoreMain(() => {}, memFs());
    const a = connectChild(main);
    const b = connectChild(main);
    const seenB = vi.fn();
    await a.proxy.write(["cfg"], { x: 1 });
    b.proxy.subscribe(["cfg"], seenB);
    await a.proxy.update(["cfg"], { y: 2 });
    expect(seenB).toHaveBeenCalledWith({ x: 1, y: 2 });
    expect(await b.proxy.read(["cfg"], {})).toEqual({ x: 1, y: 2 });
  });

  it("DECAY regression: a fresh instance reads/writes the same doc after the old one drops", async () => {
    const fs = memFs();
    const main = new StoreMain(() => {}, fs);

    const first = connectChild(main);
    await first.proxy.write(["cfg"], { v: 1 });
    first.detach(); // the "old instance" dies — its subscriptions are dropped

    // A brand-new instance connects and must see the persisted value + persist more.
    const second = connectChild(main);
    expect(await second.proxy.read(["cfg"], {})).toEqual({ v: 1 });
    await second.proxy.write(["cfg"], { v: 2 });
    expect(fs.disk.get("cfg")).toEqual({ v: 2 });
  });
});
