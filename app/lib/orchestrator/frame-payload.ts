// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { FrameMeta, FramePayload, ShmFrameRef } from "./protocol.js";

export type ShmReadResult = {
  seq: bigint;
  gen: number;
  retries: number;
  /** Active frame size (C-20 dynamic pipe resize); absent on the fixed-size
   *  live SHM path (the reader still returns them = the segment dims). */
  width?: number;
  height?: number;
  /** Frame-bound crop origin in the parent stream (v4, fovea pipes). */
  originX?: number;
  originY?: number;
  /** Actual payload byte length the reader copied (ring v5 `payloadBytes`) —
   *  present ONLY when the slot records a nonzero length (compression bricks);
   *  absent on dim-derived frames (the consumer falls back to dims). */
  bytes?: number;
  meta?: FrameMeta;
};

export function mergeFrameMeta(
  ...items: Array<FrameMeta | null | undefined>
): FrameMeta | undefined {
  let merged: FrameMeta | undefined;
  for (const item of items) {
    if (!item) continue;
    merged = { ...merged, ...item };
  }
  return merged;
}

export function withFrameMeta(
  payload: FramePayload,
  ...items: Array<FrameMeta | null | undefined>
): FramePayload {
  const meta = mergeFrameMeta(payload.meta, ...items);
  return meta ? { ...payload, meta } : { ...payload };
}

export function frameByteLength(
  payload: Pick<FramePayload, "shape" | "channels">,
): number {
  return payload.shape.reduce((p, n) => p * n, payload.channels);
}

export function withShmReadResult(
  payload: FramePayload & { shm: ShmFrameRef },
  data: ArrayBuffer,
  result: ShmReadResult,
): FramePayload {
  return {
    data,
    shape: payload.shape,
    channels: payload.channels,
    meta: mergeFrameMeta(payload.meta, result.meta),
    shm: {
      ...payload.shm,
      gen: result.gen,
      seq: result.seq,
      retries: result.retries,
    },
  };
}
