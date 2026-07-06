// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { Mat } from "core/Vision";
import type { FrameMeta, FramePayload } from "@lib/orchestrator/protocol";

export type SessionFrameSource = FramePayload | Mat<Uint8Array>;

export interface FrameTransport {
  write(
    topic: string,
    source: SessionFrameSource,
    meta?: FrameMeta,
  ): FramePayload;
  close(topic?: string): void;
}

type NormalizedFrame = {
  bytes: Uint8Array;
  shape: number[];
  channels: number;
  meta?: FrameMeta;
};

type ShmSlot = {
  /** Read snapshot under the Electron V8 cage — never write through it. */
  view(): Mat<Uint8Array>;
  /** Native memcpy into the slot — the only correct write path (V13). */
  write(src: ArrayBufferView): void;
};

type ShmWriter = {
  nextSlot(shape: number[], channels: number): ShmSlot;
  publish(meta?: FrameMeta): FramePayload;
  close(): void;
};

export type ShmApi = {
  topicKey(topic: string): string;
  Writer: new (key: string) => ShmWriter;
};

function isFramePayload(source: SessionFrameSource): source is FramePayload {
  return !(source instanceof Uint8Array);
}

function normalizeFrame(
  source: SessionFrameSource,
  meta?: FrameMeta,
): FramePayload | NormalizedFrame {
  if (isFramePayload(source)) {
    if (source.shm && !source.data) {
      return meta ? { ...source, meta: { ...source.meta, ...meta } } : source;
    }
    if (!source.data) throw new Error("Frame payload has neither data nor shm");
    return {
      bytes: new Uint8Array(source.data),
      shape: source.shape,
      channels: source.channels,
      meta: { ...source.meta, ...meta },
    };
  }
  return {
    bytes: new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
    shape: source.shape,
    channels: source.channels,
    meta,
  };
}

export function createShmFrameTransport(Shm: ShmApi): FrameTransport {
  const writers = new Map<string, ShmWriter>();

  function writer(topic: string): ShmWriter {
    let w = writers.get(topic);
    if (!w) {
      w = new Shm.Writer(Shm.topicKey(topic));
      writers.set(topic, w);
    }
    return w;
  }

  return {
    write(topic, source, meta) {
      const frame = normalizeFrame(source, meta);
      if (!("bytes" in frame)) return frame;

      const w = writer(topic);
      const slot = w.nextSlot(frame.shape, frame.channels);
      // Native memcpy into the slot — never `slot.view().set(...)`: under
      // Electron's V8 memory cage `view()` is a read snapshot and the write
      // would land in the throwaway copy (V13).
      slot.write(frame.bytes);
      return w.publish(frame.meta);
    },
    close(topic) {
      if (topic) {
        writers.get(topic)?.close();
        writers.delete(topic);
        return;
      }
      for (const w of writers.values()) w.close();
      writers.clear();
    },
  };
}
