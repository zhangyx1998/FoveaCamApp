// Session lifecycle: subscribe -> activate, last-unsubscribe -> idle,
// dispose() (docs/history/refactor/orchestrator.md §7.1 item 2, second target).
// Exercises `ServerSession`/`defineSession` directly — no `Hub` needed,
// since interest counting lives entirely on `ServerSession` itself; `Hub`
// only routes the wire-level subscribe/unsubscribe topics to it.

import { describe, expect, it, vi } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import { Channel, cmd, defineContract, topic } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

const testContract = defineContract({
  state: {},
  telemetry: { ready: false as boolean },
  frames: [] as const,
  commands: { ping: cmd<void, string>() },
});

// A `Channel` needs a real `Endpoint`, but these tests never need the other
// side to actually receive anything (session-side effects, e.g. state/
// telemetry seeding on subscribe, are fire-and-forget `emit` calls) — so
// discarding the peer half of the pair is fine.
function fakeChannel(): Channel {
  const [ep] = createEndpointPair();
  return new Channel(ep);
}

function channelPair(): { client: Channel; server: Channel } {
  const [epClient, epServer] = createEndpointPair();
  return {
    client: new Channel(epClient),
    server: new Channel(epServer),
  };
}

function testSession(hooks: { activate?: () => void; idle?: () => void }) {
  return defineSession("test", testContract, () => ({
    commands: { async ping() { return "pong"; } },
    ...hooks,
  }));
}

describe("session lifecycle", () => {
  it("activate() fires on the first subscribe, not on later ones", () => {
    const activate = vi.fn();
    const session = testSession({ activate });
    session.subscribe(fakeChannel());
    expect(activate).toHaveBeenCalledTimes(1);
    session.subscribe(fakeChannel());
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("idle() fires only once the last subscriber unsubscribes", () => {
    const idle = vi.fn();
    const session = testSession({ idle });
    const ch1 = fakeChannel();
    const ch2 = fakeChannel();
    session.subscribe(ch1);
    session.subscribe(ch2);
    session.unsubscribe(ch1);
    expect(idle).not.toHaveBeenCalled();
    session.unsubscribe(ch2);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("going idle then re-subscribing fires activate() again", () => {
    const activate = vi.fn();
    const session = testSession({ activate });
    const ch = fakeChannel();
    session.subscribe(ch);
    session.unsubscribe(ch);
    session.subscribe(ch);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe() of a never-subscribed channel is a no-op", () => {
    const idle = vi.fn();
    const session = testSession({ idle });
    session.unsubscribe(fakeChannel());
    expect(idle).not.toHaveBeenCalled();
  });

  it("dispose() force-idles regardless of subscriber count", () => {
    const idle = vi.fn();
    const session = testSession({ idle });
    session.subscribe(fakeChannel());
    session.subscribe(fakeChannel());
    session.dispose();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears the subscriber count, so a later genuine subscribe re-activates", () => {
    const activate = vi.fn();
    const session = testSession({ activate });
    session.subscribe(fakeChannel());
    session.subscribe(fakeChannel());
    expect(activate).toHaveBeenCalledTimes(1);
    session.dispose();
    session.subscribe(fakeChannel());
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("passive subscribe seeds observation but does not activate", () => {
    const activate = vi.fn();
    const idle = vi.fn();
    const session = testSession({ activate, idle });
    const ch = fakeChannel();
    session.subscribe(ch, { passive: true });
    session.unsubscribe(ch, { passive: true });
    expect(activate).not.toHaveBeenCalled();
    expect(idle).not.toHaveBeenCalled();
  });

  it("active sessions broadcast telemetry to passive observers", async () => {
    const activate = vi.fn();
    const session = testSession({ activate });
    const passive = channelPair();
    const active = fakeChannel();
    const seen: boolean[] = [];

    passive.client.on(topic.telemetry("test"), (patch: { ready: boolean }) => {
      seen.push(patch.ready);
    });
    session.subscribe(passive.server, { passive: true });
    session.subscribe(active);
    session.telemetry({ ready: true });
    await flush();
    await flush();

    expect(activate).toHaveBeenCalledTimes(1);
    expect(seen).toContain(true);
  });

  it("resetTelemetry() republishes the contract defaults", async () => {
    const session = testSession({});
    const p = channelPair();
    const seen: boolean[] = [];

    p.client.on(topic.telemetry("test"), (patch: { ready?: boolean }) => {
      if ("ready" in patch) seen.push(patch.ready!);
    });
    session.subscribe(p.server);
    await flush();
    session.telemetry({ ready: true });
    await flush();
    session.resetTelemetry();
    await flush();

    expect(seen).toEqual([testContract.telemetry.ready, true, testContract.telemetry.ready]);
  });

  it("last active unsubscribe idles even with passive observers attached", () => {
    const idle = vi.fn();
    const session = testSession({ activate: vi.fn(), idle });
    const passive = fakeChannel();
    const active = fakeChannel();

    session.subscribe(passive, { passive: true });
    session.subscribe(active);
    session.unsubscribe(active);
    expect(idle).toHaveBeenCalledTimes(1);

    session.unsubscribe(passive, { passive: true });
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it("passive observer can upgrade to active on the same channel", () => {
    const activate = vi.fn();
    const idle = vi.fn();
    const session = testSession({ activate, idle });
    const ch = fakeChannel();

    session.subscribe(ch, { passive: true });
    expect(activate).not.toHaveBeenCalled();
    session.subscribe(ch);
    expect(activate).toHaveBeenCalledTimes(1);
    session.unsubscribe(ch);
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
