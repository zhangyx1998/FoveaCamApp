// Session lifecycle: subscribe -> activate, last-unsubscribe -> idle,
// dispose() (docs/refactor/orchestrator.md §7.1 item 2, second target).
// Exercises `ServerSession`/`defineSession` directly — no `Hub` needed,
// since interest counting lives entirely on `ServerSession` itself; `Hub`
// only routes the wire-level subscribe/unsubscribe topics to it.

import { describe, expect, it, vi } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import { Channel, cmd, defineContract } from "@lib/orchestrator/protocol";
import { createEndpointPair } from "./fake-endpoint";

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
});
