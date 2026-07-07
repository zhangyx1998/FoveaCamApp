import {
  setFrameTransportFactory,
} from "@orchestrator/runtime";
import type {
  FrameTransport,
  SessionFrameSource,
} from "@orchestrator/frame-transport";
import type { FrameMeta, FramePayload } from "@lib/orchestrator/protocol";
import { mergeFrameMeta } from "@lib/orchestrator/frame-payload";

export type FakeWrite = {
  topic: string;
  bytes: Uint8Array;
  payload: FramePayload;
};

export class FakeFrameTransport implements FrameTransport {
  writes: FakeWrite[] = [];
  closed = false;
  private seq = 0n;
  private topics = new Map<string, { shape: string; channels: number; generation: number }>();

  write(topic: string, source: SessionFrameSource, meta?: FrameMeta): FramePayload {
    const shape = source.shape;
    const channels = source.channels;
    const bytes =
      source instanceof Uint8Array
        ? new Uint8Array(source)
        : source.data
          ? new Uint8Array(source.data)
          : new Uint8Array(0);
    const shapeKey = JSON.stringify(shape);
    const prev = this.topics.get(topic);
    const generation =
      !prev ? 1 : prev.shape === shapeKey && prev.channels === channels ? prev.generation : prev.generation + 1;
    this.topics.set(topic, { shape: shapeKey, channels, generation });
    const payload: FramePayload = {
      shape,
      channels,
      meta: mergeFrameMeta("meta" in source ? source.meta : undefined, meta),
      shm: { seg: `/fake.${topic}`, gen: generation, seq: ++this.seq },
    };
    this.writes.push({ topic, bytes, payload });
    return payload;
  }

  close(): void {
    this.closed = true;
  }

  materialize(payload: FramePayload): Uint8Array | null {
    return (
      this.writes.find(
        (w) =>
          w.payload.shm?.seg === payload.shm?.seg &&
          w.payload.shm?.seq === payload.shm?.seq,
      )?.bytes ?? null
    );
  }
}

export function installFakeFrameTransport(): FakeFrameTransport[] {
  const transports: FakeFrameTransport[] = [];
  setFrameTransportFactory(() => {
    const transport = new FakeFrameTransport();
    transports.push(transport);
    return transport;
  });
  return transports;
}
