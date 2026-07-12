// Coverage for the pure CoalescedWriter (@lib/coalesced-writer) — the
// per-camera slider-write coalescer behind manage-cameras `set` — plus its
// read-back companion `readControlPatch` (@lib/camera-config). Verifies
// drop-order coalescing, single-in-flight serialization, trailing-debounce
// persistence of the final accepted value, the rejection path, and
// clear/dispose lifecycle.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CoalescedWriter } from "@lib/coalesced-writer";
import { readControlPatch } from "@lib/camera-config";

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain the pump's await hops (each write completion is a microtask). */
async function microtasks(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CoalescedWriter", () => {
  it("coalesces to the latest value per key while a write is in flight", async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const writes: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: (key, value) => {
        writes.push([key, value]);
        const gate = deferred();
        gates.push(gate);
        return gate.promise;
      },
      persist: () => {},
    });
    w.submit("exposure", 1);
    await microtasks();
    expect(writes).toEqual([["exposure", 1]]);
    w.submit("exposure", 2);
    w.submit("exposure", 3); // overwrites 2 — must never reach the device
    gates[0].resolve();
    await microtasks();
    expect(writes).toEqual([
      ["exposure", 1],
      ["exposure", 3],
    ]);
    gates[1].resolve();
    await microtasks();
    expect(writes).toHaveLength(2); // final value landed, nothing extra
  });

  it("keeps at most one write in flight, serving keys in submit order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const w = new CoalescedWriter({
      write: async (key) => {
        order.push(key);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
      },
      persist: () => {},
    });
    w.submit("exposure", 1);
    w.submit("gain", 2);
    w.submit("black_level", 3);
    await microtasks(30);
    expect(order).toEqual(["exposure", "gain", "black_level"]);
    expect(maxInFlight).toBe(1);
  });

  it("persists only the final accepted value, trailing-debounced", async () => {
    vi.useFakeTimers();
    const persisted: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: () => {},
      persist: (key, value) => {
        persisted.push([key, value]);
      },
    });
    w.submit("gain", 1);
    await vi.advanceTimersByTimeAsync(150);
    w.submit("gain", 2); // resets the trailing timer; 1 must never persist
    await vi.advanceTimersByTimeAsync(299);
    expect(persisted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(persisted).toEqual([["gain", 2]]);
  });

  it("debounces persistence independently per key", async () => {
    vi.useFakeTimers();
    const persisted: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: () => {},
      persist: (key, value) => {
        persisted.push([key, value]);
      },
      persistDelay: 100,
    });
    w.submit("exposure", 10);
    w.submit("gain", 20);
    await vi.advanceTimersByTimeAsync(100);
    expect(persisted.sort()).toEqual([
      ["exposure", 10],
      ["gain", 20],
    ]);
  });

  it("reports a rejected write via onResult and never persists it", async () => {
    vi.useFakeTimers();
    const persisted: [string, unknown][] = [];
    const results: [string, unknown, string | undefined][] = [];
    const w = new CoalescedWriter({
      write: (_key, value) => {
        if (value === 666) throw new Error("refused");
      },
      onResult: (key, value, error) =>
        results.push([key, value, error instanceof Error ? error.message : undefined]),
      persist: (key, value) => {
        persisted.push([key, value]);
      },
    });
    w.submit("exposure", 1); // accepted
    await vi.advanceTimersByTimeAsync(0);
    w.submit("exposure", 666); // refused — must not reschedule/replace persist
    await vi.advanceTimersByTimeAsync(300);
    expect(results).toEqual([
      ["exposure", 1, undefined],
      ["exposure", 666, "refused"],
    ]);
    // The last ACCEPTED value persists — the device truth.
    expect(persisted).toEqual([["exposure", 1]]);
  });

  it("routes persist rejections to onPersistError and keeps persisting", async () => {
    vi.useFakeTimers();
    const persisted: [string, unknown][] = [];
    const errors: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: () => {},
      persist: (key, value) => {
        if (value === 13) return Promise.reject(new Error("store down"));
        persisted.push([key, value]);
      },
      onPersistError: (key, value) => errors.push([key, value]),
      persistDelay: 50,
    });
    w.submit("gain", 13);
    await vi.advanceTimersByTimeAsync(50);
    w.submit("gain", 14);
    await vi.advanceTimersByTimeAsync(50);
    expect(errors).toEqual([["gain", 13]]);
    expect(persisted).toEqual([["gain", 14]]);
  });

  it("clear drops queued writes and pending persists without flushing", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const writes: [string, unknown][] = [];
    const persisted: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: (key, value) => {
        writes.push([key, value]);
        return key === "exposure" ? gate.promise : undefined;
      },
      persist: (key, value) => {
        persisted.push([key, value]);
      },
    });
    w.submit("exposure", 1); // in flight (gated)
    w.submit("gain", 2); // queued
    await microtasks();
    w.clear();
    gate.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([["exposure", 1]]); // gain write dropped
    // exposure completed AFTER clear so its (post-clear) persist may fire;
    // gain must not — it never reached the device.
    expect(persisted).not.toContainEqual(["gain", 2]);
  });

  it("dispose flushes pending persists immediately and refuses new writes", async () => {
    vi.useFakeTimers();
    const writes: [string, unknown][] = [];
    const persisted: [string, unknown][] = [];
    const w = new CoalescedWriter({
      write: (key, value) => {
        writes.push([key, value]);
      },
      persist: (key, value) => {
        persisted.push([key, value]);
      },
    });
    w.submit("gain", 5);
    await vi.advanceTimersByTimeAsync(0); // written; persist still debounced
    expect(persisted).toEqual([]);
    await w.dispose(); // no timer advance — flush must be immediate
    expect(persisted).toEqual([["gain", 5]]);
    w.submit("gain", 6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([["gain", 5]]);
    expect(persisted).toEqual([["gain", 5]]);
  });
});

const identitySafe = <T>(get: () => T, fallback: T): T => {
  try {
    return get();
  } catch {
    return fallback;
  }
};

describe("readControlPatch (targeted read-back)", () => {
  const camera: Record<string, any> = {
    exposure: 8000,
    exposure_range: { min: 10, max: 100000 },
    exposure_auto_available: true,
    exposure_auto: "Off",
    frame_rate: 30,
    frame_rate_range: { min: 1, max: 60 },
    frame_rate_available: true,
    frame_rate_enable: true,
  };

  it("reads exactly the written control's field family", () => {
    const patch = readControlPatch(camera, "exposure", identitySafe);
    expect(patch).toEqual({
      exposure: 8000,
      exposure_range: { min: 10, max: 100000 },
      exposure_auto_available: true,
      exposure_auto: "Off",
    });
  });

  it("resolves a control from any of its field keys", () => {
    const patch = readControlPatch(camera, "frame_rate_enable", identitySafe);
    expect(Object.keys(patch!).sort()).toEqual([
      "frame_rate",
      "frame_rate_available",
      "frame_rate_enable",
      "frame_rate_range",
    ]);
  });

  it("returns undefined for keys outside the schema (caller full-polls)", () => {
    expect(readControlPatch(camera, "pixel_format", identitySafe)).toBeUndefined();
    expect(readControlPatch(camera, "role", identitySafe)).toBeUndefined();
  });
});
