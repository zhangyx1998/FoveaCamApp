// Controller stream helpers (docs/refactor/synced-capture.md ST-64a/ST-64c):
// allocator capacity/reuse and host-side stream update suppression are pure
// logic, so test them without opening serial hardware.

import { describe, expect, it, vi } from "vitest";

vi.mock("core/Controller", () => ({
  Device: class {},
  Protocol: {},
}));

vi.mock("serialport", () => ({
  SerialPort: { list: vi.fn(async () => []) },
}));

import {
  STREAM_CAPACITY,
  StreamIdPool,
  StreamUpdateGate,
} from "@orchestrator/controller";

describe("Controller stream helpers", () => {
  it("allocates the full 64-stream range and rejects the 65th stream", () => {
    const pool = new StreamIdPool();
    const ids = Array.from({ length: STREAM_CAPACITY }, () => pool.allocate());

    expect(ids).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(() => pool.allocate()).toThrow("Stream capacity (64) exceeded");
  });

  it("reuses a released stream id", () => {
    const pool = new StreamIdPool();
    expect(pool.allocate()).toBe(0);
    expect(pool.allocate()).toBe(1);
    pool.release(0);
    expect(pool.allocate()).toBe(0);
  });

  it("skips identical targets and enforces a per-stream minimum interval", () => {
    const gate = new StreamUpdateGate(
      { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } },
      1,
      10,
    );

    expect(gate.accept({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }, 12)).toBe(false);
    expect(gate.accept({ left: { x: 1, y: 0 }, right: { x: 0, y: 0 } }, 10.5)).toBe(false);
    expect(gate.accept({ left: { x: 1, y: 0 }, right: { x: 0, y: 0 } }, 11)).toBe(true);
    expect(gate.accept({ left: { x: 1, y: 0 }, right: { x: 0, y: 0 } }, 12)).toBe(false);
  });
});
