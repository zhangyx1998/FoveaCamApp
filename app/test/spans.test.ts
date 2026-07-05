// Structured timing spans (docs/refactor/orchestrator.md §7.1 S5): the
// `span()`/`spans()` ring in `orchestrator/diagnostics.ts`, `Hub.reportSpan`'s
// live broadcast (same pattern as `reportError`), and `ServerSession`'s
// generic "activate -> first frame" measurement.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineSession, Hub } from "@orchestrator/runtime";
import { Channel, cmd, defineContract, topic, type FramePayload } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

beforeEach(() => {
  vi.resetModules();
});

describe("diagnostics span ring", () => {
  it("records spans and forwards them via onSpan", async () => {
    const { span, spans, onSpan } = await import("@orchestrator/diagnostics");
    const forwarded = vi.fn();
    onSpan(forwarded);
    span("boot.test", 12.5, { foo: "bar" });
    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({ name: "boot.test", ms: 12.5, meta: { foo: "bar" } });
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ name: "boot.test" }));
  });

  it("timeSpan measures an async function and records its duration", async () => {
    const { timeSpan, spans } = await import("@orchestrator/diagnostics");
    const result = await timeSpan("work", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    });
    expect(result).toBe(42);
    expect(spans()).toHaveLength(1);
    expect(spans()[0].name).toBe("work");
    expect(spans()[0].ms).toBeGreaterThanOrEqual(0);
  });

  it("caps the ring at its fixed capacity, dropping the oldest first", async () => {
    const { span, spans } = await import("@orchestrator/diagnostics");
    for (let i = 0; i < 250; i++) span(`s${i}`, i);
    const all = spans();
    expect(all.length).toBe(200);
    expect(all[0].name).toBe("s50"); // oldest 50 dropped
    expect(all[all.length - 1].name).toBe("s249");
  });
});

describe("Hub.reportSpan", () => {
  it("broadcasts a span to every connected channel's topic.span listeners", async () => {
    const hub = new Hub();
    const [epA, epB] = createEndpointPair();
    const chServer = new Channel(epA);
    const chClient = new Channel(epB);
    // `Hub.attach` expects a real `MessagePortMain` (Electron-only); reach
    // into the private `channels` set directly instead — the same one
    // `reportError` (already tested via code review) broadcasts over.
    (hub as any).channels.add(chServer);

    const received: unknown[] = [];
    chClient.on(topic.span, (s) => received.push(s));
    hub.reportSpan({ name: "x", ms: 1, t: Date.now() });
    await flush();

    expect(received).toEqual([{ name: "x", ms: 1, t: expect.any(Number) }]);
  });
});

describe("ServerSession: activate -> first frame span", () => {
  const testContract = defineContract({
    state: {},
    telemetry: {},
    frames: ["r"] as const,
    commands: { publish: cmd<number>() },
  });

  const mkPayload = (tag: number): FramePayload => ({
    data: new ArrayBuffer(0),
    shape: [tag],
    channels: 1,
  });

  it("records exactly one timeToFirstFrame span per activation, on the first frame() call", async () => {
    const { onSpan } = await import("@orchestrator/diagnostics");
    const { defineSession: define } = await import("@orchestrator/runtime");
    const recorded: string[] = [];
    onSpan((s) => recorded.push(s.name));

    const session = define("v5", testContract, (s) => ({
      commands: {
        async publish(tag: number) {
          s.frame("r", mkPayload(tag));
        },
      },
    }));
    const [epServer, epClient] = createEndpointPair();
    const chServer = new Channel(epServer);
    const chClient = new Channel(epClient);
    session.attach(chServer);
    session.subscribe(chServer);

    await chClient.request(topic.command("v5", "publish"), 1);
    await chClient.request(topic.command("v5", "publish"), 2);

    expect(recorded.filter((n) => n === "session.v5.timeToFirstFrame")).toHaveLength(1);
  });

  it("records a fresh span on re-activation after going idle", async () => {
    const { onSpan } = await import("@orchestrator/diagnostics");
    const { defineSession: define } = await import("@orchestrator/runtime");
    const recorded: string[] = [];
    onSpan((s) => recorded.push(s.name));

    const session = define("v5b", testContract, (s) => ({
      commands: {
        async publish(tag: number) {
          s.frame("r", mkPayload(tag));
        },
      },
    }));
    const [epServer, epClient] = createEndpointPair();
    const chServer = new Channel(epServer);
    const chClient = new Channel(epClient);
    session.attach(chServer);

    session.subscribe(chServer);
    await chClient.request(topic.command("v5b", "publish"), 1);
    session.unsubscribe(chServer);
    session.subscribe(chServer);
    await chClient.request(topic.command("v5b", "publish"), 2);

    expect(recorded.filter((n) => n === "session.v5b.timeToFirstFrame")).toHaveLength(2);
  });
});
