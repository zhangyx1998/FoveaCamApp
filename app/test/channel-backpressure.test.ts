// Channel backpressure gate: latest-wins coalescing, fack accounting, and
// C10 per-frame-topic interest gating (docs/history/refactor/orchestrator.md §7.1
// item 2, third target). Drives two real `Channel`s over a fake `Endpoint`
// pair — no session/Hub involved, this is pure transport-layer behavior.

import { describe, expect, it } from "vitest";
import { Channel, type FramePayload } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

const mkPayload = (tag: number): FramePayload => ({
  data: new ArrayBuffer(0),
  shape: [tag],
  channels: 1,
});

describe("Channel backpressure gate", () => {
  it("without an ack, rapid sends coalesce: only the first is posted, the rest collapse to the latest", () => {
    const [ep] = createEndpointPair(); // no peer wired — nothing will ever ack
    const server = new Channel(ep);
    server.sendFrame("t", mkPayload(1));
    server.sendFrame("t", mkPayload(2));
    server.sendFrame("t", mkPayload(3));
    const stats = server.stats("t");
    expect(stats.offered).toBe(3);
    expect(stats.sent).toBe(1); // only the first ever got posted (gate is closed)
    expect(stats.coalesced).toBe(1); // payload 2 was discarded in favor of 3
  });

  it("end-to-end: the receiver only ever sees the first and the latest, never a middle one", async () => {
    const [ep1, ep2] = createEndpointPair();
    const server = new Channel(ep1);
    const client = new Channel(ep2);
    const received: number[] = [];
    client.onFrame("t", (p) => received.push(p.shape[0]));

    server.sendFrame("t", mkPayload(1));
    server.sendFrame("t", mkPayload(2));
    server.sendFrame("t", mkPayload(3));

    // 1: frame 1 delivered to client; 2: client's fack delivered to server
    // (server posts frame 3 from `framePending`); 3: frame 3 delivered to
    // client. A couple of extra turns are harmless.
    for (let i = 0; i < 5; i++) await flush();

    expect(received).toEqual([1, 3]); // never 2
    const stats = server.stats("t");
    expect(stats).toEqual({ offered: 3, sent: 2, coalesced: 1, bytes: 0 });
  });

  it("can carry a shm descriptor frame without an in-band ArrayBuffer", async () => {
    const [ep1, ep2] = createEndpointPair();
    const server = new Channel(ep1);
    const client = new Channel(ep2);
    const received: FramePayload[] = [];
    client.onFrame("t", (p) => received.push(p));

    server.sendFrame("t", {
      shape: [2, 3],
      channels: 4,
      shm: { seg: "/fv.test.1", gen: 1, seq: 7n },
    });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].shm?.seg).toBe("/fv.test.1");
    expect(server.stats("t").bytes).toBe(0);
  });

  it("allFrameStats includes counter windows, rates, and producer convert timing", () => {
    const [ep] = createEndpointPair();
    const server = new Channel(ep);
    server.sendFrame("t", {
      data: new ArrayBuffer(4),
      shape: [1, 1],
      channels: 4,
      meta: { convertMs: 2 },
    });

    const snapshot = server.allFrameStats()["t"];
    expect(snapshot).toMatchObject({
      offered: 1,
      sent: 1,
      coalesced: 0,
      bytes: 4,
      timing: { convertMs: { count: 1, mean: 2, max: 2 } },
    });
    expect(snapshot.window.uptimeMs).toBeGreaterThan(0);
    expect(snapshot.rates.sentPerSec).toBeGreaterThan(0);
  });

  it("after an ack, the gate reopens: a fresh send after the in-flight one settles is posted immediately", async () => {
    const [ep1, ep2] = createEndpointPair();
    const server = new Channel(ep1);
    const client = new Channel(ep2);
    const received: number[] = [];
    client.onFrame("t", (p) => received.push(p.shape[0]));

    server.sendFrame("t", mkPayload(1));
    await flush(); // frame 1 -> client
    await flush(); // fack -> server (nothing pending, gate just closes)

    server.sendFrame("t", mkPayload(2));
    // No coalescing this time — the gate was open, so `sendFrame` posts
    // straight away instead of waiting in `framePending`.
    expect(server.stats("t")).toEqual({ offered: 2, sent: 2, coalesced: 0, bytes: 0 });

    await flush();
    expect(received).toEqual([1, 2]);
  });

  it("C10: a channel only shows interest after declareFrameInterest, and it's per-topic", async () => {
    const [ep1, ep2] = createEndpointPair();
    const server = new Channel(ep1);
    const client = new Channel(ep2);

    expect(server.hasFrameInterest("fr:s:a")).toBe(false);
    client.declareFrameInterest("fr:s:a");
    await flush();
    expect(server.hasFrameInterest("fr:s:a")).toBe(true);
    // A different topic the client never asked about stays uninterested.
    expect(server.hasFrameInterest("fr:s:b")).toBe(false);
  });

  it("declaring interest twice is idempotent (no duplicate wire traffic assumed elsewhere)", async () => {
    const [ep1, ep2] = createEndpointPair();
    const server = new Channel(ep1);
    const client = new Channel(ep2);
    client.declareFrameInterest("fr:s:a");
    client.declareFrameInterest("fr:s:a");
    await flush();
    expect(server.hasFrameInterest("fr:s:a")).toBe(true);
  });
});
