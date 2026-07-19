// One-shot frame topics (e.g. a
// capture preview, published exactly once) must still reach a channel that
// opens its `frame(name)` ref *after* the publish — otherwise the payload is
// silently dropped (no listener existed yet client-side, and with interest-gating the
// server wouldn't even attempt the send). `ServerSession` now caches the
// last payload per topic and replays it when a channel declares interest.

import { describe, expect, it } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import { Channel, cmd, defineContract, topic, type FramePayload } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";
import { installFakeFrameTransport } from "./fake-frame-transport";

const testContract = defineContract({
  state: {},
  telemetry: {},
  frames: ["r"] as const,
  commands: { publish: cmd<number>() },
});

const mkPayload = (tag: number): FramePayload => ({
  data: Uint8Array.of(tag).buffer,
  shape: [tag],
  channels: 1,
});

function setup() {
  const transports = installFakeFrameTransport();
  const session = defineSession("v4", testContract, (s) => ({
    commands: {
      async publish(tag: number) {
        s.frame("r", mkPayload(tag));
      },
    },
  }));
  const [epClient, epServer] = createEndpointPair();
  const chClient = new Channel(epClient);
  const chServer = new Channel(epServer);
  const sent: FramePayload[] = [];
  const sendFrame = chServer.sendFrame.bind(chServer);
  chServer.sendFrame = (name, payload) => {
    sent.push(payload);
    sendFrame(name, payload);
  };
  session.attach(chServer);
  session.subscribe(chServer);
  return { session, chClient, chServer, transports, sent };
}

describe("V4: one-shot frame replay on late interest", () => {
  it("replays the last payload to a channel that declares interest after the publish", async () => {
    const { chClient, transports, sent } = setup();
    // Publish happens before the client ever asks for the topic — exactly
    // the race in `manual-control/capture.ts`: the server stores a resource
    // and publishes its preview before the renderer's `capture_meta` watcher
    // reacts and calls `session.frame(name)` for the first time.
    await chClient.request(topic.command("v4", "publish"), 1);

    const received: FramePayload[] = [];
    chClient.onFrame(topic.frame("v4", "r"), (p) => received.push(p));
    chClient.declareFrameInterest(topic.frame("v4", "r"));
    await flush();
    await flush();
    await flush();

    expect(received.map((p) => p.shape[0])).toEqual([1]);
    expect(received[0].data).toBeUndefined();
    expect(transports[0].materialize(received[0])?.[0]).toBe(1);
    expect(sent.every((p) => p.data === undefined)).toBe(true);
  });

  it("a normal live publish after interest is already declared still works", async () => {
    const { chClient, sent } = setup();
    const received: FramePayload[] = [];
    chClient.onFrame(topic.frame("v4", "r"), (p) => received.push(p));
    chClient.declareFrameInterest(topic.frame("v4", "r"));
    await flush();

    await chClient.request(topic.command("v4", "publish"), 1);
    await flush();
    await flush();

    expect(received.map((p) => p.shape[0])).toEqual([1]);
    expect(received[0].data).toBeUndefined();
    expect(sent.every((p) => p.data === undefined)).toBe(true);
  });

  it("publishes a new shm generation when the frame shape changes", async () => {
    const { chClient, sent } = setup();
    const received: FramePayload[] = [];
    chClient.onFrame(topic.frame("v4", "r"), (p) => received.push(p));
    chClient.declareFrameInterest(topic.frame("v4", "r"));
    await flush();

    await chClient.request(topic.command("v4", "publish"), 1);
    await chClient.request(topic.command("v4", "publish"), 2);
    await flush();
    await flush();

    expect(received.map((p) => p.shm?.gen)).toEqual([1, 2]);
    expect(received.every((p) => p.data === undefined)).toBe(true);
    expect(sent.every((p) => p.data === undefined)).toBe(true);
  });

  it("clears the cache when the session goes idle, so a later interest gets nothing replayed", async () => {
    const { session, chClient, chServer } = setup();
    await chClient.request(topic.command("v4", "publish"), 1);
    session.unsubscribe(chServer); // the only subscriber leaves -> idle -> cache cleared

    const received: number[] = [];
    chClient.onFrame(topic.frame("v4", "r"), (p) => received.push(p.shape[0]));
    chClient.declareFrameInterest(topic.frame("v4", "r"));
    await flush();
    await flush();
    await flush();

    expect(received).toEqual([]);
  });

  it("dispose() also clears the cache", async () => {
    const { session, chClient } = setup();
    await chClient.request(topic.command("v4", "publish"), 1);
    session.dispose();

    const received: number[] = [];
    chClient.onFrame(topic.frame("v4", "r"), (p) => received.push(p.shape[0]));
    chClient.declareFrameInterest(topic.frame("v4", "r"));
    await flush();
    await flush();
    await flush();

    expect(received).toEqual([]);
  });
});
