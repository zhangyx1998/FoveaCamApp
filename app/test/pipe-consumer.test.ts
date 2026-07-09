// C-17: the renderer pipe-consumer loop — polls the reader (injected), tracks
// lastSeq, emits FramePayloads, recycles the displaced buffer, and stops on the
// explicit CLOSED signal. Driven with a scripted reader (no native/preload).

import { describe, expect, it, vi } from "vitest";
import {
  createPipeConsumer,
  type PipeReaderIO,
} from "@lib/orchestrator/pipe-consumer";
import type { PipeHandle } from "@lib/orchestrator/pipe-contract";
import type { FramePayload } from "@lib/orchestrator/protocol";
import type { PipeReadFrame } from "@lib/orchestrator/shm-client";

function handle(): PipeHandle {
  return {
    pipeId: "p",
    shmName: "/fv.pX.g1",
    spec: {
      id: "p",
      pixelFormat: "Mono8",
      dtype: "U8",
      width: 4,
      height: 3,
      channels: 1,
      stride: 4,
      bytesPerFrame: 12,
      ringDepth: 3,
    },
    ringDepth: 3,
    epoch: 1,
    headerLayout: { layoutVersion: 4, magic: "FVSHMRG" },
  };
}

describe("pipe consumer (C-17)", () => {
  it("polls, tracks lastSeq, emits FramePayloads, recycles the displaced buffer", async () => {
    const frames = [
      { data: new ArrayBuffer(12), seq: 1n, tCapture: 1 },
      { data: new ArrayBuffer(12), seq: 2n, tCapture: 2 },
    ];
    const seen: bigint[] = [];
    const released: ArrayBuffer[] = [];
    let call = 0;
    const io: PipeReaderIO = {
      readPipe: vi.fn(async (name, lastSeq, bytes) => {
        seen.push(lastSeq);
        expect(name).toBe("/fv.pX.g1");
        expect(bytes).toBe(12);
        return frames[call++] ?? null;
      }),
      releaseBuffer: (b) => {
        if (b) released.push(b);
      },
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(handle(), io, (f) => out.push(f));
    await c.poll(); // frame 1
    await c.poll(); // frame 2 → recycles frame 1's buffer
    await c.poll(); // null (no new frame)

    expect(out.filter(Boolean)).toHaveLength(2);
    expect(seen).toEqual([0n, 1n, 2n]); // lastSeq progression
    expect(out[0]!.meta!.seq).toBe(1);
    expect(out[0]!.shape).toEqual([3, 4]); // [height, width]
    expect(out[0]!.channels).toBe(1);
    expect(released).toEqual([frames[0].data]); // displaced buffer returned to pool
  });

  it("builds the FramePayload from the frame's ACTIVE w/h (C-20 resize)", async () => {
    // Frames carry a varying active size inside the max ring; the payload shape
    // must track it, not the spec nominal (3×4).
    const frames = [
      { data: new ArrayBuffer(12), seq: 1n, width: 2, height: 2 },
      { data: new ArrayBuffer(12), seq: 2n, width: 4, height: 3 },
    ];
    let call = 0;
    const io: PipeReaderIO = {
      readPipe: vi.fn(async () => frames[call++] ?? null),
      releaseBuffer: vi.fn(),
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(handle(), io, (f) => out.push(f));
    await c.poll();
    await c.poll();
    expect(out[0]!.shape).toEqual([2, 2]); // [height, width] from the frame
    expect(out[1]!.shape).toEqual([3, 4]);
  });

  it("provisions the read buffer at maxBytes on a C-20 variable-size pipe", async () => {
    // The ring's slots are sized to `maxBytes` (Pipe.cpp passes it as the slot
    // override) and the reader REJECTS a smaller destination (DestTooSmall) —
    // provisioning the nominal bytesPerFrame made every read of a dynamic pipe
    // throw, silently retried as a "transport hiccup" ("No Frame" forever).
    const h = handle();
    h.spec.maxWidth = 8;
    h.spec.maxHeight = 6;
    h.spec.maxBytes = 48;
    const bytesSeen: number[] = [];
    const io: PipeReaderIO = {
      readPipe: vi.fn(async (_n, _s, bytes) => {
        bytesSeen.push(bytes);
        return { data: new ArrayBuffer(48), seq: 1n, width: 4, height: 3 };
      }),
      releaseBuffer: vi.fn(),
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(h, io, (f) => out.push(f));
    await c.poll();
    expect(bytesSeen).toEqual([48]); // slot size, not the 12-byte nominal
    expect(out[0]!.shape).toEqual([3, 4]); // active dims still drive the shape
  });

  it("stops on the CLOSED signal and clears the display", async () => {
    const io: PipeReaderIO = {
      readPipe: vi.fn(async () => "closed" as const),
      releaseBuffer: vi.fn(),
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(handle(), io, (f) => out.push(f));
    await c.poll();
    expect(c.closed).toBe(true);
    expect(out).toEqual([null]);
    await c.poll(); // once closed, no further reads
    expect((io.readPipe as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("swallows a transport error and retries the next poll", async () => {
    let n = 0;
    const io: PipeReaderIO = {
      readPipe: vi.fn(async () => {
        if (n++ === 0) throw new Error("pipe read timed out");
        return { data: new ArrayBuffer(12), seq: 5n };
      }),
      releaseBuffer: vi.fn(),
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(handle(), io, (f) => out.push(f));
    await c.poll(); // throws → swallowed, no emit
    expect(out).toHaveLength(0);
    await c.poll(); // frame
    expect(out.filter(Boolean)).toHaveLength(1);
  });

  it("recycles the fresh buffer when stop() lands mid-poll (pool discipline)", async () => {
    // A stop() during an in-flight read must not push the resolved frame to the
    // torn-down sink NOR strand its fresh pool buffer in `displayed` — the
    // buffer must return to the pool (the reuse invariant this loop implements).
    let resolveRead!: (v: PipeReadFrame | "closed" | null) => void;
    const buf = new ArrayBuffer(12);
    const released: ArrayBuffer[] = [];
    const io: PipeReaderIO = {
      readPipe: vi.fn(
        () => new Promise<PipeReadFrame | "closed" | null>((res) => (resolveRead = res)),
      ),
      releaseBuffer: (b) => {
        if (b) released.push(b);
      },
    };
    const out: (FramePayload | null)[] = [];
    const c = createPipeConsumer(handle(), io, (f) => out.push(f));
    const p = c.poll(); // read in flight (awaiting the deferred resolve)
    c.stop(); // stop lands while the read is pending
    resolveRead({ data: buf, seq: 1n }); // read resolves AFTER stop
    await p;
    expect(out).toHaveLength(0); // never displayed to the torn-down sink
    expect(released).toEqual([buf]); // fresh buffer returned to the pool, not stranded
  });

  it("stop() releases the displayed buffer", async () => {
    const buf = new ArrayBuffer(12);
    const released: ArrayBuffer[] = [];
    const io: PipeReaderIO = {
      readPipe: vi.fn(async () => ({ data: buf, seq: 1n })),
      releaseBuffer: (b) => {
        if (b) released.push(b);
      },
    };
    const c = createPipeConsumer(handle(), io, () => {});
    await c.poll();
    c.stop();
    expect(released).toEqual([buf]);
  });
});
