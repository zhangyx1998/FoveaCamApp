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
});
