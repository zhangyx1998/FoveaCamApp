// `retryUntil` (pure) + `matchTriple` (against a stubbed `core/Aravis` +
// store) — docs/refactor/orchestrator.md §7.1 item 2, fifth/last target.
// This is what closes RT1 (the renderer<->orchestrator camera handoff race):
// a camera still mid-release by the other process is simply absent from
// enumeration for a beat, and `retryUntil` is what turns that transient gap
// into a bounded retry instead of a sticky `ready: false`.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCameraKey, type Role } from "@lib/camera-config";

describe("retryUntil", () => {
  it("returns immediately if the first attempt succeeds", async () => {
    const { retryUntil } = await import("@orchestrator/registry");
    const attempt = vi.fn(async () => "ok");
    const result = await retryUntil(attempt, { timeoutMs: 1000, intervalMs: 10 });
    expect(result).toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries on a null result and returns once an attempt succeeds", async () => {
    const { retryUntil } = await import("@orchestrator/registry");
    let calls = 0;
    const attempt = vi.fn(async () => (++calls < 3 ? null : "ok"));
    const result = await retryUntil(attempt, { timeoutMs: 1000, intervalMs: 1 });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up and returns null once the timeout elapses", async () => {
    const { retryUntil } = await import("@orchestrator/registry");
    const attempt = vi.fn(async () => null);
    const result = await retryUntil(attempt, { timeoutMs: 20, intervalMs: 5 });
    expect(result).toBeNull();
    expect(attempt.mock.calls.length).toBeGreaterThan(1);
  });
});

// --- matchTriple: role-matching against a fake `core/Aravis` -------------

type FakeCamera = { serial: string; model: string; vendor: string; release: () => void };

function fakeCamera(serial: string): FakeCamera {
  return { serial, model: "M", vendor: "V", release: vi.fn() };
}

describe("matchTriple", () => {
  let cameras: FakeCamera[];
  let roleOf: Map<string, Role>;

  beforeEach(() => {
    vi.resetModules();
    cameras = [];
    roleOf = new Map();

    vi.doMock("core/Aravis", () => ({
      Camera: {
        list: vi.fn(async () => cameras.map((c) => ({ ...c }))),
      },
    }));
    // `applyStoredConfig` (registry.ts's `registerShared`) reads via the raw
    // `store.ts`; `matchTriple` itself reads role via `store-hub.ts`. Both
    // just need to answer "no stored config" / "this camera's role" —
    // keyed the same way `cameraConfigPath`/`getCameraKey` would derive it.
    vi.doMock("@orchestrator/store", () => ({
      read: vi.fn(async (_path: string[], fallback: unknown) => fallback),
    }));
    vi.doMock("@orchestrator/store-hub", () => ({
      read: vi.fn(async (path: string[], fallback: unknown) => {
        const key = path[path.length - 1];
        for (const [serial, role] of roleOf) {
          if (getCameraKey({ vendor: "V", model: "M", serial }) === key) return { role };
        }
        return fallback;
      }),
    }));
  });

  it("returns the leased triple when all three roles are present", async () => {
    cameras = [fakeCamera("L"), fakeCamera("C"), fakeCamera("R")];
    roleOf.set("L", "L");
    roleOf.set("C", "C");
    roleOf.set("R", "R");

    const { matchTriple } = await import("@orchestrator/registry");
    const result = await matchTriple();
    expect(result).not.toBeNull();
    expect(result!.L.camera.serial).toBe("L");
    expect(result!.C.camera.serial).toBe("C");
    expect(result!.R.camera.serial).toBe("R");
  });

  it("returns null and releases the partial match when a role is missing", async () => {
    // Only L and C are present — matching the RT1 symptom: R is transiently
    // absent from enumeration (still mid-release by the other process).
    cameras = [fakeCamera("L"), fakeCamera("C")];
    roleOf.set("L", "L");
    roleOf.set("C", "C");

    const { matchTriple } = await import("@orchestrator/registry");
    const result = await matchTriple();
    expect(result).toBeNull();
  });

  it("keeps only the first camera when two share the same stored role", async () => {
    cameras = [fakeCamera("L1"), fakeCamera("L2"), fakeCamera("C"), fakeCamera("R")];
    roleOf.set("L1", "L");
    roleOf.set("L2", "L"); // duplicate role — should be released, not kept
    roleOf.set("C", "C");
    roleOf.set("R", "R");

    const { matchTriple } = await import("@orchestrator/registry");
    const result = await matchTriple();
    expect(result).not.toBeNull();
    expect(result!.L.camera.serial).toBe("L1");
  });

  it("retryUntil(matchTriple) succeeds once a transiently-missing camera reappears", async () => {
    // First matchTriple() call: R is missing (simulating the RT1 race).
    // Second call: R has shown up (the other process finished releasing it).
    cameras = [fakeCamera("L"), fakeCamera("C")];
    roleOf.set("L", "L");
    roleOf.set("C", "C");

    const { matchTriple, retryUntil } = await import("@orchestrator/registry");
    setTimeout(() => {
      cameras = [fakeCamera("L"), fakeCamera("C"), fakeCamera("R")];
      roleOf.set("R", "R");
    }, 10);

    const result = await retryUntil(matchTriple, { timeoutMs: 500, intervalMs: 5 });
    expect(result).not.toBeNull();
    expect(Object.keys(result!)).toEqual(expect.arrayContaining(["L", "C", "R"]));
  });
});
