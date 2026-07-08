// Session drain support for the multi-window switch path (A-6, docs/history/refactor/
// multi-window.md §3): async `idle` settlement via `drained()` and the
// `busy()` refusal probe — what the orchestrator's `window:drain` handler
// composes into "closed = session-idle-drained, refused when mid-capture".

import { describe, expect, it } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import { Channel, cmd, defineContract } from "@lib/orchestrator/protocol";
import { createEndpointPair } from "./fake-endpoint";

const testContract = defineContract({
  state: {},
  telemetry: {},
  frames: [] as const,
  commands: { ping: cmd<void, string>() },
});

function fakeChannel(): Channel {
  const [ep] = createEndpointPair();
  return new Channel(ep);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("session drain (multi-window)", () => {
  it("drained() resolves only after an async idle settles", async () => {
    const gate = deferred();
    let idleDone = false;
    const session = defineSession("test", testContract, () => ({
      commands: { async ping() { return "pong"; } },
      async idle() {
        await gate.promise;
        idleDone = true;
      },
    }));
    session.subscribe(fakeChannel());
    session.dispose(); // starts the async idle

    let settled = false;
    const wait = session.drained().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false); // idle still draining
    gate.resolve();
    await wait;
    expect(idleDone).toBe(true);
  });

  it("drained() resolves immediately when the session never idled", async () => {
    const session = defineSession("test", testContract, () => ({
      commands: { async ping() { return "pong"; } },
    }));
    await session.drained(); // must not hang
  });

  it("a rejected idle does not wedge drained()", async () => {
    const session = defineSession("test", testContract, () => ({
      commands: { async ping() { return "pong"; } },
      async idle() {
        throw new Error("release failed");
      },
    }));
    session.subscribe(fakeChannel());
    session.dispose();
    await session.drained(); // swallowed (reported), not propagated
  });

  it("busyReason() surfaces the definition's busy() probe", () => {
    let recording = false;
    const session = defineSession("test", testContract, () => ({
      commands: { async ping() { return "pong"; } },
      busy: () => (recording ? "recording in progress" : null),
    }));
    expect(session.busyReason()).toBeNull();
    recording = true;
    expect(session.busyReason()).toBe("recording in progress");
  });

  it("sessions without a busy() probe report not-busy", () => {
    const session = defineSession("test", testContract, () => ({
      commands: { async ping() { return "pong"; } },
    }));
    expect(session.busyReason()).toBeNull();
  });
});
