// C-P2: pin the renderer SHM transfer pool's buffer-ownership contract after
// extracting it out of `client.ts` into `@lib/orchestrator/shm-client`.
// MessagePort transfer moves buffer ownership away and back, so the regression
// surface is "does every read path return its buffer to the pool exactly once":
// success (via release), null, error, timeout, and stale/late replies.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShmClient } from "@lib/orchestrator/shm-client";
import type { FramePayload } from "@lib/orchestrator/protocol";

/** A fake preload port: records posted read requests, lets the test drive the
 *  read-done reply. No real transfer/neutering — we assert pool bookkeeping. */
function fakePort() {
  const posted: Array<{
    kind: string;
    id: number;
    payload: FramePayload;
    buffer: ArrayBuffer;
  }> = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    posted,
    postMessage(data: unknown) {
      posted.push(data as (typeof posted)[number]);
    },
    close: vi.fn(),
    start: vi.fn(),
  };
  return port;
}

/** A fresh shm descriptor with no `data` yet (forces a transfer read). All
 *  fixtures share shape/channels so they land in the same pool byte-bucket. */
function shmPayload(): FramePayload {
  return {
    shape: [2, 2],
    channels: 1,
    shm: { seg: "seg-a", gen: 1, seq: 5n },
  };
}

const reply = (
  port: ReturnType<typeof fakePort>,
  msg: {
    id: number;
    payload: FramePayload | null;
    buffer?: ArrayBuffer;
    error?: string;
  },
) => port.onmessage?.({ data: { kind: "fovea:shm:read-done", ...msg } });

beforeEach(() => {
  // The transfer path is guarded on `typeof window`; node env has none.
  vi.stubGlobal("window", {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shm-client transfer pool", () => {
  it("passes through payloads that already carry data or aren't shm", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const withData: FramePayload = { shape: [1], channels: 1, data: new ArrayBuffer(1) };
    const nonShm: FramePayload = { shape: [1], channels: 1 };
    expect(await client.read(withData)).toBe(withData);
    expect(await client.read(nonShm)).toBe(nonShm);
    // Neither touched the port.
    expect(port.posted).toHaveLength(0);
  });

  it("SUCCESS: buffer becomes payload.data, returns to pool via release()", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const p = client.read(shmPayload());
    const req = port.posted[0];
    const out = { ...shmPayload(), data: req.buffer };
    reply(port, { id: req.id, payload: out });
    expect(await p).toBe(out);
    expect(client.stats()).toMatchObject({ reads: 1, allocations: 1, poolHits: 0, inFlight: 0 });
    expect(client.stats().rates.reads.count).toBe(1);
    expect(client.stats().workload.outputs.reads.count).toBe(1);
    expect(client.stats().workload.inputs.requests.count).toBe(1);

    // Buffer is only reclaimed once the frame is displaced.
    client.release(out);
    const p2 = client.read(shmPayload());
    expect(port.posted[1].buffer).toBe(req.buffer); // recycled, not reallocated
    expect(client.stats().poolHits).toBe(1);
    expect(client.stats().allocations).toBe(1);
    reply(port, { id: port.posted[1].id, payload: null, buffer: port.posted[1].buffer });
    await p2;
  });

  it("NULL: buffer is reclaimed to the pool immediately", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const p = client.read(shmPayload());
    const req = port.posted[0];
    reply(port, { id: req.id, payload: null, buffer: req.buffer });
    expect(await p).toBeNull();
    expect(client.stats()).toMatchObject({ nulls: 1, reads: 0, inFlight: 0 });

    // Reclaimed without any release() call → next read recycles it.
    client.read(shmPayload());
    expect(port.posted[1].buffer).toBe(req.buffer);
    expect(client.stats().poolHits).toBe(1);
  });

  it("ERROR: swallowed to null, buffer reclaimed", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const p = client.read(shmPayload());
    const req = port.posted[0];
    reply(port, { id: req.id, payload: null, buffer: req.buffer, error: "boom" });
    expect(await p).toBeNull();
    expect(client.stats()).toMatchObject({ errors: 1, inFlight: 0 });

    client.read(shmPayload());
    expect(port.posted[1].buffer).toBe(req.buffer);
    expect(client.stats().poolHits).toBe(1);
  });

  it("TIMEOUT: read rejects→null; STALE late reply reclaims the buffer", async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const p = client.read(shmPayload());
    const req = port.posted[0];
    await vi.advanceTimersByTimeAsync(250);
    expect(await p).toBeNull();
    expect(client.stats()).toMatchObject({ timeouts: 1, inFlight: 0 });

    // The buffer was still in the preload's hands; the late (now pending-less)
    // reply is the STALE path that returns it to the pool.
    reply(port, { id: req.id, payload: { ...shmPayload(), data: req.buffer }, buffer: req.buffer });
    const p2 = client.read(shmPayload());
    expect(port.posted[1].buffer).toBe(req.buffer);
    expect(client.stats().poolHits).toBe(1);
    reply(port, { id: port.posted[1].id, payload: null, buffer: port.posted[1].buffer });
    await p2;
  });

  it("STALE: a reply with no matching pending entry never throws", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const stray = new ArrayBuffer(4);
    // No read in flight; must not throw, and reclaims the buffer.
    expect(() => reply(port, { id: 999, payload: null, buffer: stray })).not.toThrow();
    const withData: FramePayload = { shape: [1], channels: 1, data: new ArrayBuffer(1) };
    expect(await client.read(withData)).toBe(withData);
  });

  it("DISPOSE: pending reads reject (→null), port closes, pool clears", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const p = client.read(shmPayload());
    expect(port.posted).toHaveLength(1);
    client.dispose();
    expect(await p).toBeNull();
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(client.stats().inFlight).toBe(0);
  });

  it("unavailable port: read swallows to null without throwing", async () => {
    const client = createShmClient(() => null);
    expect(await client.read(shmPayload())).toBeNull();
  });

  it("LATENCY (C-P9): sampled on completed reads, not on timeout", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    // A completed round-trip adds one latency sample.
    const p = client.read(shmPayload());
    const req = port.posted[0];
    reply(port, { id: req.id, payload: { ...shmPayload(), data: req.buffer } });
    await p;
    expect(client.stats().latencyMs.count).toBe(1);
    expect(client.stats().latencyMs.mean).toBeGreaterThanOrEqual(0);
    expect(client.stats().latencyMs.max).toBeGreaterThanOrEqual(0);

    // A timeout is not a round-trip → no new latency sample.
    vi.useFakeTimers();
    const p2 = client.read(shmPayload());
    await vi.advanceTimersByTimeAsync(250);
    expect(await p2).toBeNull();
    expect(client.stats().latencyMs.count).toBe(1);
  });

  it("N=3 same-size streams — pool auto-sizes, ZERO steady-state allocation", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const N = 3;
    const WORKING_SET = 2 * N; // per stream: 1 in-flight (transferred) + 1 displayed

    // One cycle = check out `count` same-size buffers CONCURRENTLY (the real
    // peak is N in-flight + N displayed), reply success to each, and return the
    // materialized payloads (buffers now "displayed", still outstanding).
    async function acquire(count: number): Promise<FramePayload[]> {
      const base = port.posted.length;
      const reads = Array.from({ length: count }, () => client.read(shmPayload()));
      for (let i = base; i < base + count; i++) {
        const req = port.posted[i];
        reply(port, { id: req.id, payload: { ...shmPayload(), data: req.buffer } });
      }
      return Promise.all(reads) as Promise<FramePayload[]>;
    }

    // Warm up: acquire the full 2N working set at once, then release it. The
    // pool auto-grows its cap to the high-water mark (2N) — one alloc per
    // working-set buffer, nothing more.
    const warm = await acquire(WORKING_SET);
    const warmupAllocs = client.stats().allocations;
    expect(warmupAllocs).toBe(WORKING_SET);
    warm.forEach((p) => client.release(p));

    // Steady state: reacquire + release the same working set repeatedly. Every
    // checkout must hit the retained pool — allocations must NOT climb.
    const ROUNDS = 5;
    for (let r = 0; r < ROUNDS; r++) {
      const bufs = await acquire(WORKING_SET);
      bufs.forEach((p) => client.release(p));
    }
    expect(client.stats().allocations).toBe(warmupAllocs); // delta 0
    expect(client.stats().poolHits).toBe(WORKING_SET * ROUNDS); // all reused
  });

  it("a resolution/format switch releases the old size's retained buffers", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const sizeA = (): FramePayload => ({ shape: [2, 2], channels: 1, shm: { seg: "a", gen: 1, seq: 5n } });
    const sizeB = (): FramePayload => ({ shape: [4, 4], channels: 1, shm: { seg: "b", gen: 1, seq: 5n } });

    // Read one frame of `mk`'s size and return the materialized payload.
    const readOne = async (mk: () => FramePayload): Promise<FramePayload> => {
      const p = client.read(mk());
      const req = port.posted[port.posted.length - 1];
      reply(port, { id: req.id, payload: { ...mk(), data: req.buffer } });
      return (await p) as FramePayload;
    };

    // Warm size A and release it → A's buffer sits in A's free-list.
    client.release(await readOne(sizeA));
    const allocsAfterA = client.stats().allocations;

    // Switch to size B (different byte length): the B checkout evicts idle A.
    client.release(await readOne(sizeB));

    // Back to A: its buffer was freed on the switch, so A must RE-allocate
    // (a poolHit here would mean the old size lingered indefinitely).
    await readOne(sizeA);
    expect(client.stats().allocations).toBe(allocsAfterA + 2); // +1 for B, +1 re-alloc A
  });

  it("the retention cap is WINDOWED — decays after the working set shrinks (value-sweep)", async () => {
    // The free-list retention cap is a sliding
    // window max: once the working set shrinks past a couple of windows, the cap
    // decays and surplus buffers are let go.
    const port = fakePort();
    let t = 1000;
    const WINDOW = 5000; // must match RETENTION_WINDOW_MS
    const client = createShmClient(() => port as unknown as MessagePort, () => t);

    async function acquire(count: number): Promise<FramePayload[]> {
      const base = port.posted.length;
      const reads = Array.from({ length: count }, () => client.read(shmPayload()));
      for (let i = base; i < base + count; i++) {
        const req = port.posted[i];
        reply(port, { id: req.id, payload: { ...shmPayload(), data: req.buffer } });
      }
      return Promise.all(reads) as Promise<FramePayload[]>;
    }

    // A peak of 2 concurrent same-size buffers → cap 2, both retained.
    (await acquire(2)).forEach((p) => client.release(p));
    expect(client.stats().allocations).toBe(2);

    // Single-buffer reads for > 2 full windows: the working set is now 1, so the
    // windowed peak decays to 1 and the pool sheds the surplus buffer.
    for (let r = 0; r < 6; r++) {
      t += WINDOW;
      (await acquire(1)).forEach((p) => client.release(p));
    }
    expect(client.stats().allocations).toBe(2); // the loop only ever reused

    // A fresh 2-concurrent burst now needs 2 buffers but the pool retains only 1
    // (the decayed cap) → exactly ONE re-allocation.
    (await acquire(2)).forEach((p) => client.release(p));
    expect(client.stats().allocations).toBe(3);
  });
});

// capture-recorder-nodes Phase 0: the FIFO `readPipeSeq` round-trip. Same pool
// as the latest-wins path (a frame's buffer must be released; notYet/gone/closed
// reclaim it immediately), but a wider outcome set (frame / notyet / gone /
// closed). Drives the preload via the fake port's read-seq-done reply.
describe("shm-client readPipeSeq (FIFO)", () => {
  const BYTES = 16;
  const seqReply = (
    port: ReturnType<typeof fakePort>,
    msg: Record<string, unknown> & { id: number; buffer: ArrayBuffer },
  ) => port.onmessage?.({ data: { kind: "fovea:pipe:read-seq-done", ...msg } });
  const lastReq = (port: ReturnType<typeof fakePort>) =>
    port.posted[port.posted.length - 1] as unknown as {
      kind: string;
      id: number;
      shmName: string;
      wantSeq: bigint;
      buffer: ArrayBuffer;
    };

  it("FRAME: resolves the frame; buffer returns to pool via releaseBuffer", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);

    const p = client.readPipeSeq("seg", 7n, BYTES);
    const req = lastReq(port);
    expect(req.kind).toBe("fovea:pipe:read-seq");
    expect(req.wantSeq).toBe(7n);
    seqReply(port, { id: req.id, buffer: req.buffer, seq: 7n, width: 4, height: 4 });
    const r = await p;
    expect(r).toMatchObject({ seq: 7n, data: req.buffer, width: 4, height: 4 });
    expect(client.stats().reads).toBe(1);

    // Buffer only recycles once the consumer returns it.
    client.releaseBuffer((r as { data: ArrayBuffer }).data);
    const p2 = client.readPipeSeq("seg", 8n, BYTES);
    expect(lastReq(port).buffer).toBe(req.buffer); // reused, no re-alloc
    expect(client.stats().poolHits).toBe(1);
    seqReply(port, { id: lastReq(port).id, buffer: lastReq(port).buffer, notYet: true });
    await p2;
  });

  it("NOTYET: resolves 'notyet' and reclaims the buffer immediately", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const p = client.readPipeSeq("seg", 1n, BYTES);
    const req = lastReq(port);
    seqReply(port, { id: req.id, buffer: req.buffer, notYet: true });
    expect(await p).toBe("notyet");
    // Reclaimed without releaseBuffer → next read reuses it.
    client.readPipeSeq("seg", 1n, BYTES);
    expect(lastReq(port).buffer).toBe(req.buffer);
    expect(client.stats().poolHits).toBe(1);
  });

  it("GONE: resolves { gone, oldestSeq } and reclaims the buffer", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const p = client.readPipeSeq("seg", 3n, BYTES);
    const req = lastReq(port);
    seqReply(port, { id: req.id, buffer: req.buffer, gone: true, oldestSeq: 33n });
    expect(await p).toEqual({ gone: true, oldestSeq: 33n });
    client.readPipeSeq("seg", 33n, BYTES);
    expect(lastReq(port).buffer).toBe(req.buffer); // reclaimed → reused
  });

  it("CLOSED: resolves 'closed' and reclaims the buffer", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const p = client.readPipeSeq("seg", 9n, BYTES);
    const req = lastReq(port);
    seqReply(port, { id: req.id, buffer: req.buffer, closed: true });
    expect(await p).toBe("closed");
    client.readPipeSeq("seg", 9n, BYTES);
    expect(lastReq(port).buffer).toBe(req.buffer);
  });

  it("STALE/late seq reply reclaims its buffer without throwing", () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const stray = new ArrayBuffer(BYTES);
    expect(() =>
      seqReply(port, { id: 4242, buffer: stray, notYet: true }),
    ).not.toThrow();
  });

  it("DISPOSE rejects a pending FIFO read", async () => {
    const port = fakePort();
    const client = createShmClient(() => port as unknown as MessagePort);
    const p = client.readPipeSeq("seg", 1n, BYTES);
    client.dispose();
    await expect(p).rejects.toThrow(/disposed/);
  });
});
