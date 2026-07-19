import { describe, expect, it } from "vitest";
import {
  frameByteLength,
  mergeFrameMeta,
  withFrameMeta,
  withShmReadResult,
} from "@lib/orchestrator/frame-payload";
import type { FramePayload } from "@lib/orchestrator/protocol";

describe("frame-payload helpers", () => {
  it("merges frame meta with later sources taking precedence", () => {
    const meta = mergeFrameMeta(
      { tCapture: 1, convertMs: 2, seq: 3 },
      { tCapture: 4, source: { session: "a", frame: "x" } },
      { seq: 5 },
    );

    expect(meta).toEqual({
      tCapture: 4,
      convertMs: 2,
      seq: 5,
      source: { session: "a", frame: "x" },
    });
  });

  it("adds meta without mutating the input payload", () => {
    const payload: FramePayload = {
      shape: [2, 3],
      channels: 4,
      meta: { tCapture: 1, seq: 1 },
      shm: { seg: "/fv.test.g1", gen: 1, seq: 1n },
    };

    const next = withFrameMeta(payload, { tCapture: 2, convertMs: 3 });

    expect(next.meta).toEqual({ tCapture: 2, seq: 1, convertMs: 3 });
    expect(payload.meta).toEqual({ tCapture: 1, seq: 1 });
  });

  it("materializes SHM read results with native meta taking precedence", () => {
    const data = new ArrayBuffer(24);
    const payload: FramePayload & { shm: NonNullable<FramePayload["shm"]> } = {
      shape: [2, 3],
      channels: 4,
      meta: { tCapture: 1, convertMs: 1, seq: 7 },
      shm: { seg: "/fv.test.g1", gen: 1, seq: 7n },
    };

    const next = withShmReadResult(payload, data, {
      gen: 2,
      seq: 9n,
      retries: 3,
      meta: { tCapture: 10, convertMs: 4, deviceTimestamp: 11n },
    });

    expect(next).toMatchObject({
      data,
      shape: [2, 3],
      channels: 4,
      meta: { tCapture: 10, convertMs: 4, seq: 7, deviceTimestamp: 11n },
      shm: { seg: "/fv.test.g1", gen: 2, seq: 9n, retries: 3 },
    });
  });

  it("computes display-frame byte length from shape and channels", () => {
    expect(frameByteLength({ shape: [5, 7], channels: 4 })).toBe(140);
  });
});
