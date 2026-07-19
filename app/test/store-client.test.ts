// The renderer `Store` client over the MAIN authority (config-store-main-
// authority.md), driven through a fake `window.foveaBridge` backed by a real
// `StoreMain` (in-memory fs). Covers: an edit sends a key-level PATCH (diff, not
// whole-doc); an incoming change from ANOTHER window applies onto the SAME
// reactive object (identity preserved) and the `applying`/acked guard prevents a
// write loop; and the DECAY fix — the client works with ONLY `foveaBridge`
// present (it never captures an orchestrator channel), so nothing dies with an
// instance.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { StoreMain } from "../electron/store-main";
import type { StoreFsBackend } from "@lib/store-authority";
import type { PatchOp } from "@lib/store-patch";
import { wireDecode, wireEncode } from "@lib/store-codec";

const flush = () => new Promise((r) => setTimeout(r, 0));

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

// One shared main + client-window fixture (the `Store` module is a singleton
// with a module-level registry + one-shot `onStoreChanged` wiring, so all cases
// share it and use DISTINCT paths to stay isolated).
const fs = memFs();
let changedCb: ((path: string[], value: unknown) => void) | null = null;
// The client window's fake webContents; a DIFFERENT id models "another window".
const clientWc = { id: 1, once: () => {} } as any;
const otherWc = { id: 2, once: () => {} } as any;
const main = new StoreMain((wc, path, value) => {
  if (wc === clientWc) changedCb?.(path, value);
}, fs);

const patchCalls: Array<{ path: string[]; ops: PatchOp[] }> = [];
const foveaBridge = {
  // Faithful stand-in for preload: opaque pass-through of WIRE-ENCODED strings.
  readStore: (path: string[], fb: string) => main.read(clientWc, path, fb),
  readStoreOnce: (path: string[], fb: string) => main.readOnce(path, fb),
  patchStore: (path: string[], ops: string) => {
    patchCalls.push({ path, ops: wireDecode<PatchOp[]>(ops) });
    return main.patch(clientWc, path, ops).then(() => undefined);
  },
  clearStore: (path: string[]) => main.clear(clientWc, path),
  listStore: (path: string[]) => main.list(path),
  onStoreChanged: (cb: (path: string[], value: unknown) => void) => {
    changedCb = cb;
    return () => (changedCb = null);
  },
};

let Store: typeof import("@lib/store").default;

beforeAll(async () => {
  (globalThis as any).window = { foveaBridge };
  Store = (await import("@lib/store")).default;
});

describe("renderer Store client", () => {
  it("open() reads the initial value and tracks it reactively", async () => {
    await main.patch(otherWc, ["c-init"], wireEncode([{ key: "a", value: 1 }]));
    const doc = await Store.open<{ a: number }>(["c-init"], { a: 0 } as any);
    expect(doc.a).toBe(1);
  });

  it("an edit sends a key-level PATCH diff, not a whole-doc write", async () => {
    const doc = await Store.open<Record<string, unknown>>(["c-edit"], {} as any);
    patchCalls.length = 0;
    (doc as any).foo = "bar";
    await flush();
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0].path).toEqual(["c-edit"]);
    expect(patchCalls[0].ops).toEqual([{ key: "foo", value: "bar" }]);
    expect(fs.disk.get("c-edit")).toEqual({ foo: "bar" });
  });

  it("a second edit only diffs the CHANGED key (D4-safe granularity)", async () => {
    const doc = await Store.open<Record<string, unknown>>(["c-diff"], { a: 1, b: 1 } as any);
    await flush();
    patchCalls.length = 0;
    (doc as any).b = 2;
    await flush();
    expect(patchCalls.at(-1)?.ops).toEqual([{ key: "b", value: 2 }]);
  });

  it("applies an external change in place (identity preserved) with NO write loop", async () => {
    const doc = await Store.open<Record<string, unknown>>(["c-ext"], { a: 1 } as any);
    await flush();
    const ref = doc;
    patchCalls.length = 0;
    // Another window patches a different key → main broadcasts to the client.
    await main.patch(otherWc, ["c-ext"], wireEncode([{ key: "b", value: 9 }]));
    await flush();
    expect(doc).toBe(ref); // same object reference
    expect((doc as any).b).toBe(9);
    expect(patchCalls).toHaveLength(0); // the applying/acked guard suppressed a redundant patch
  });

  it("read() is a one-shot snapshot that does not subscribe", async () => {
    await main.patch(otherWc, ["c-once"], wireEncode([{ key: "k", value: 3 }]));
    expect(await Store.read(["c-once"], {})).toEqual({ k: 3 });
  });

  it("works with ONLY foveaBridge present — no orchestrator channel captured (decay fix)", async () => {
    // This whole suite runs without any `connect()`/orchestrator port; a
    // persisted edit proves the store client never depends on a dying channel.
    const doc = await Store.open<Record<string, unknown>>(["c-decay"], {} as any);
    (doc as any).persisted = true;
    await flush();
    expect(fs.disk.get("c-decay")).toEqual({ persisted: true });
  });

  it("a Mat-shaped TypedArray keeps its attached shape across the wire (undistort crash regression)", async () => {
    // Calibration Mats are Float64Arrays with EXPANDO
    // props (`shape`, `channels`) the codec re-attaches; bare structured clone
    // strips them, so a shapeless Mat fails the native Undistort
    // ("Mat.shape must be an array of integers"). The
    // wire framing (codec-JSON both directions) must round-trip them.
    const mat = Object.assign(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), {
      shape: [3, 3],
      channels: 1,
    });
    await main.patch(otherWc, ["c-mat"], wireEncode([{ key: "camera_matrix", value: mat }]));
    const doc = await Store.read<{ camera_matrix?: Float64Array & { shape?: number[] } }>(
      ["c-mat"],
      {},
    );
    expect(doc.camera_matrix).toBeInstanceOf(Float64Array);
    expect(Array.from(doc.camera_matrix!)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(doc.camera_matrix!.shape).toEqual([3, 3]); // the prop structured clone strips
    expect((doc.camera_matrix as any).channels).toBe(1);
  });

  it("a SUBARRAY TypedArray view round-trips by its own bytes (latent)", () => {
    // A view with a non-zero byteOffset (or shorter length) must round-trip by
    // its own bytes, not as a full-buffer array (wrong values AND wrong
    // length): byteOffset/byteLength must be honored.
    const backing = new Float64Array([9, 9, 1.5, -2.25, 3, 4, 9]);
    const view = Object.assign(backing.subarray(2, 6), { shape: [2, 2], channels: 1 });
    const revived = wireDecode<Float64Array & { shape: number[]; channels: number }>(
      wireEncode(view),
    );
    expect(revived).toBeInstanceOf(Float64Array);
    expect(revived.length).toBe(4); // the view's length, not the backing buffer's 7
    expect(Array.from(revived)).toEqual([1.5, -2.25, 3, 4]);
    expect(revived.shape).toEqual([2, 2]);
    expect(revived.channels).toBe(1);
  });
});
