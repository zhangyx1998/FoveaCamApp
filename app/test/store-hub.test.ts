// Store-hub read/write/broadcast/echo-skip semantics (docs/refactor/
// orchestrator.md §7.1 item 2, first target in the risk-coverage order).
// `./store.js` (the fs primitives) is mocked so these tests never touch
// disk — an in-memory `Map` stands in for the filesystem.

import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, unknown>();
const keyOf = (segments: string | string[]) =>
  (Array.isArray(segments) ? segments : [segments]).join("/");

vi.mock("@orchestrator/store", () => ({
  read: vi.fn(async (segments: string | string[], fallback: unknown) => {
    const key = keyOf(segments);
    return disk.has(key) ? disk.get(key) : fallback;
  }),
  write: vi.fn(async (segments: string | string[], data: unknown) => {
    disk.set(keyOf(segments), data);
  }),
  clear: vi.fn(async (segments: string | string[]) => {
    disk.delete(keyOf(segments));
  }),
  list: vi.fn(async () => []),
}));

import { Channel } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

describe("store-hub", () => {
  beforeEach(() => {
    disk.clear();
    vi.resetModules();
  });

  it("read() populates the cache from the (mocked) fs fallback on first access", async () => {
    const { read } = await import("@orchestrator/store-hub");
    const value = await read(["a", "read-fallback"], { x: 1 });
    expect(value).toEqual({ x: 1 });
  });

  it("read() returns the persisted value once written", async () => {
    const { read, write } = await import("@orchestrator/store-hub");
    await write(["a", "read-after-write"], { x: 2 });
    expect(await read(["a", "read-after-write"], { x: 0 })).toEqual({ x: 2 });
  });

  it("update() merges a patch onto the current value (read-modify-write)", async () => {
    const { read, update, write } = await import("@orchestrator/store-hub");
    await write(["a", "update-merge"], { x: 1, y: 1 });
    await update(["a", "update-merge"], { y: 2 });
    expect(await read(["a", "update-merge"], {})).toEqual({ x: 1, y: 2 });
  });

  it("clear() removes the value; a later read falls back again", async () => {
    const { clear, read, write } = await import("@orchestrator/store-hub");
    await write(["a", "clear-me"], { x: 1 });
    await clear(["a", "clear-me"]);
    expect(await read(["a", "clear-me"], { fallback: true })).toEqual({ fallback: true });
  });

  it("attachStore: a channel's own write echoes to a peer channel but not back to itself", async () => {
    const { attachStore } = await import("@orchestrator/store-hub");
    const [epA, epB] = createEndpointPair();
    const chA = new Channel(epA); // acts as the "server" side conceptually
    const chB = new Channel(epB);
    // Both channels attach to the same store-hub instance, as if two
    // renderer windows were both connected to the orchestrator.
    attachStore(chA);
    attachStore(chB);

    const path = ["a", "echo-skip"];
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    chA.on(`store:${path.join("/")}`, (v) => seenByA.push(v));
    chB.on(`store:${path.join("/")}`, (v) => seenByB.push(v));

    // Both read once, so each channel registers its own listener for the path.
    await chA.request("store:read", { path, fallback: {} });
    await chB.request("store:read", { path, fallback: {} });

    await chA.request("store:write", { path, value: { x: 42 } });
    await flush();

    expect(seenByB).toEqual([{ x: 42 }]); // peer sees the write
    expect(seenByA).toEqual([]); // originator doesn't get its own echo
  });

  it("attachStore: store:clear removes the value for subsequent reads", async () => {
    const { attachStore } = await import("@orchestrator/store-hub");
    // Client/server topology (unlike the symmetric echo-skip test above):
    // only the server side needs `attachStore` — it's the one that receives
    // and processes the client's requests. Whichever endpoint doesn't have a
    // Channel wrapping it never gets its `onMessage` wired, so a request
    // toward it would hang forever rather than reject — both sides of the
    // pair need a real `Channel`.
    const [client, server] = createEndpointPair();
    const chClient = new Channel(client);
    const chServer = new Channel(server);
    attachStore(chServer);

    const path = ["a", "attach-clear"];
    await chClient.request("store:write", { path, value: { x: 1 } });
    await chClient.request("store:clear", { path });
    const after = await chClient.request("store:read", { path, fallback: { cleared: true } });
    expect(after).toEqual({ cleared: true });
  });

  it("serializes writes so broadcasts reflect committed values only", async () => {
    const fsStore = await import("@orchestrator/store");
    const firstWrite = new Deferred<void>();
    vi.mocked(fsStore.write).mockImplementationOnce(
      async (segments: string | string[], data: unknown) => {
        await firstWrite.promise;
        disk.set(keyOf(segments), data);
      },
    );

    const { attachStore } = await import("@orchestrator/store-hub");
    const [epA, epB] = createEndpointPair();
    const chA = new Channel(epA);
    const chB = new Channel(epB);
    attachStore(chA);
    attachStore(chB);

    const path = ["a", "serialized-write"];
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    chA.on(`store:${path.join("/")}`, (v) => seenByA.push(v));
    chB.on(`store:${path.join("/")}`, (v) => seenByB.push(v));
    await chA.request("store:read", { path, fallback: {} });
    await chB.request("store:read", { path, fallback: {} });

    const a = chA.request("store:write", { path, value: { a: 1 } });
    const b = chB.request("store:write", { path, value: { b: 2 } });
    await flush();
    expect(seenByA).toEqual([]);
    expect(seenByB).toEqual([]);

    firstWrite.resolve();
    await Promise.all([a, b]);
    await flush();

    expect(seenByB).toEqual([{ a: 1 }]);
    expect(seenByA).toEqual([{ b: 2 }]);
    expect(disk.get(path.join("/"))).toEqual({ b: 2 });
  });

  it("serializes first-load updates so concurrent patches are not lost", async () => {
    const { read, update } = await import("@orchestrator/store-hub");
    const path = ["a", "serialized-update"];

    await Promise.all([
      update(path, { a: 1 }),
      update(path, { b: 2 }),
    ]);

    expect(await read(path, {})).toEqual({ a: 1, b: 2 });
    expect(disk.get(path.join("/"))).toEqual({ a: 1, b: 2 });
  });
});
