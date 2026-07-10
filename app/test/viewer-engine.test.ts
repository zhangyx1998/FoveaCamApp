// Viewer-engine lifecycle sequencing (standalone-viewer-and-fcap, AS SHIPPED
// amendment). The engine moved from an in-renderer worker (which never worked)
// to a MAIN-owned utilityProcess per window; ViewerEngineManager owns the map +
// the ordering invariants around it. The Electron process/port wiring is
// injected, so these are the testable core:
//   • flush-before-close: the flush ack releases the grace; a wedged flush is
//     bounded by the grace timeout — either way the engine is killed.
//   • terminate-before-respawn: a re-spawn flushes + kills the previous engine
//     BEFORE the new one exists (single-writer sidecar).

import { describe, expect, it, vi } from "vitest";
import {
  ViewerEngineManager,
  flushWithGrace,
  type EngineHandle,
} from "../electron/viewer-engine";

/** A fake engine whose flush is resolved on demand (or never). */
function fakeHandle(): EngineHandle & {
  resolveFlush: () => void;
  flushCalls: number;
  killed: boolean;
} {
  let release: () => void = () => {};
  const h = {
    flushCalls: 0,
    killed: false,
    requestFlush() {
      h.flushCalls++;
      return new Promise<void>((r) => (release = r));
    },
    kill() {
      h.killed = true;
    },
    resolveFlush: () => release(),
  };
  return h;
}

/** A synchronous fake timer: `schedule` returns a token; `fire(token)` runs it. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const id = ++seq;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (t: ReturnType<typeof setTimeout>) => pending.delete(t as unknown as number),
    fire: (t: number) => {
      const fn = pending.get(t);
      pending.delete(t);
      fn?.();
    },
    pendingCount: () => pending.size,
  };
}

describe("flushWithGrace", () => {
  it("kills after the flush ack, cancelling the grace timer", async () => {
    const timers = fakeTimers();
    const h = fakeHandle();
    const done = flushWithGrace(h, 500, timers.schedule, timers.cancel);
    expect(h.flushCalls).toBe(1);
    expect(h.killed).toBe(false);
    h.resolveFlush();
    await done;
    expect(h.killed).toBe(true);
    // The ack path cancelled the timeout — no leaked timer.
    expect(timers.pendingCount()).toBe(0);
  });

  it("kills on the grace timeout when the flush never acks", async () => {
    const timers = fakeTimers();
    const h = fakeHandle();
    const done = flushWithGrace(h, 500, timers.schedule, timers.cancel);
    expect(h.killed).toBe(false);
    timers.fire(1); // deadline lapses before the (never-resolving) flush
    await done;
    expect(h.killed).toBe(true);
  });

  it("kills even if the flush rejects", async () => {
    const h: EngineHandle & { killed: boolean } = {
      killed: false,
      requestFlush: () => Promise.reject(new Error("engine gone")),
      kill() {
        this.killed = true;
      },
    };
    await flushWithGrace(h, 500, fakeTimers().schedule, () => {});
    expect(h.killed).toBe(true);
  });
});

describe("ViewerEngineManager", () => {
  it("spawns one engine per key and tracks it", async () => {
    const handles: ReturnType<typeof fakeHandle>[] = [];
    const create = vi.fn((_k: number, _f: string) => {
      const h = fakeHandle();
      handles.push(h);
      return h;
    });
    const mgr = new ViewerEngineManager({ create, graceMs: 0 });
    await mgr.spawn(7, "/a.fcap");
    expect(create).toHaveBeenCalledWith(7, "/a.fcap");
    expect(mgr.has(7)).toBe(true);
  });

  it("terminate-before-respawn: flushes + kills the old engine before creating the new", async () => {
    const timers = fakeTimers();
    const order: string[] = [];
    const handles: ReturnType<typeof fakeHandle>[] = [];
    const create = vi.fn((_k: number, file: string) => {
      order.push(`create:${file}`);
      const base = fakeHandle();
      const h = {
        ...base,
        requestFlush() {
          order.push(`flush:${file}`);
          return base.requestFlush();
        },
        kill() {
          order.push(`kill:${file}`);
          base.kill();
        },
      };
      handles.push(h as ReturnType<typeof fakeHandle>);
      return h;
    });
    const mgr = new ViewerEngineManager({
      create,
      graceMs: 500,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });

    await mgr.spawn(1, "/first.fcap"); // engine A
    const respawn = mgr.spawn(1, "/second.fcap"); // dev full-reload
    // A's flush is requested; the new engine must NOT exist until A is killed.
    expect(order).toEqual(["create:/first.fcap", "flush:/first.fcap"]);
    handles[0].resolveFlush(); // A acks → A killed → B created
    await respawn;
    expect(order).toEqual([
      "create:/first.fcap",
      "flush:/first.fcap",
      "kill:/first.fcap",
      "create:/second.fcap",
    ]);
    expect(mgr.has(1)).toBe(true);
  });

  it("close flushes + kills and drops the key", async () => {
    const h = fakeHandle();
    const mgr = new ViewerEngineManager({
      create: () => h,
      graceMs: 0,
    });
    await mgr.spawn(3, "/x.fcap");
    const closing = mgr.close(3);
    h.resolveFlush();
    await closing;
    expect(h.killed).toBe(true);
    expect(mgr.has(3)).toBe(false);
  });

  it("forget drops a crashed engine without flushing or killing", async () => {
    const h = fakeHandle();
    const mgr = new ViewerEngineManager({ create: () => h, graceMs: 0 });
    await mgr.spawn(5, "/y.fcap");
    mgr.forget(5); // proc.on('exit') path — process is already gone
    expect(mgr.has(5)).toBe(false);
    expect(h.flushCalls).toBe(0);
    expect(h.killed).toBe(false);
  });

  it("killAll terminates every engine and settles", async () => {
    const made: ReturnType<typeof fakeHandle>[] = [];
    const mgr = new ViewerEngineManager({
      create: () => {
        const h = fakeHandle();
        made.push(h);
        return h;
      },
      graceMs: 0,
    });
    await mgr.spawn(1, "/a.fcap");
    await mgr.spawn(2, "/b.fcap");
    const all = mgr.killAll();
    for (const h of made) h.resolveFlush();
    await all;
    expect(made.every((h) => h.killed)).toBe(true);
    expect(mgr.has(1)).toBe(false);
    expect(mgr.has(2)).toBe(false);
  });
});
