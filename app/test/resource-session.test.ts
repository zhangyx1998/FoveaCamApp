// Resource-scoped session lifecycle (A-P1): the generation/drain machinery
// under `defineResourceSession`. Focus is the two bug classes it exists to
// kill — ordered async drain, and stale-async-completion (idle/re-activate
// while a slow `activate` is still in flight must not leak leases).

import { describe, expect, it } from "vitest";
import {
  defineResourceSession,
  type ResourceScope,
} from "@orchestrator/resource-session";
import { Channel, defineContract, topic, type SessionStatus } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

const contract = defineContract({
  state: {},
  telemetry: { ready: false as boolean },
  frames: [] as const,
  commands: {},
});

function fakeChannel(): Channel {
  const [ep] = createEndpointPair();
  return new Channel(ep);
}

function makeSession(
  activate: (scope: ResourceScope) => void | Promise<void>,
  idle?: () => void,
) {
  return defineResourceSession("res", contract, () => ({
    activate: (scope) => activate(scope),
    idle,
    commands: {},
  }));
}

/** A few microtask turns — enough for a fire-and-forget async `activate`. */
async function settle(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await flush();
}

describe("resource-session lifecycle (A-P1)", () => {
  it("drains registered cleanups LIFO on idle, awaitable via drained()", async () => {
    const cleaned: string[] = [];
    const session = makeSession((scope) => {
      scope.defer(() => cleaned.push("a"));
      scope.defer(() => cleaned.push("b"));
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle();
    expect(cleaned).toEqual([]); // nothing torn down while active
    session.unsubscribe(ch);
    await session.drained();
    expect(cleaned).toEqual(["b", "a"]); // LIFO
  });

  it("scope.use acquires and auto-releases each resource on drain", async () => {
    const released: number[] = [];
    const session = makeSession(async (scope) => {
      await scope.use(() => Promise.resolve(1), (r) => void released.push(r));
      await scope.use(() => Promise.resolve(2), (r) => void released.push(r));
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle();
    session.unsubscribe(ch);
    await session.drained();
    expect(released).toEqual([2, 1]);
  });

  it("releases a resource a SUPERSEDED (slow) activate acquires — no leak (V5/V10)", async () => {
    const released: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const session = makeSession(async (scope) => {
      const lease = await scope.use(
        async () => {
          await gate; // slow acquisition
          return "lease";
        },
        (r) => void released.push(r),
      );
      if (!lease) return; // superseded during acquire → bail, register nothing
      scope.defer(() => released.push("tracker"));
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle(); // activate starts, blocks on gate
    session.unsubscribe(ch); // idle BEFORE the lease resolves
    await session.drained(); // drain runs (no cleanups registered yet)
    openGate(); // the slow acquire now completes
    await settle();
    expect(released).toEqual(["lease"]); // released, never installed
    expect(released).not.toContain("tracker"); // bailed after the null lease
  });

  it("a re-activation waits for the previous idle's drain before proceeding", async () => {
    const events: string[] = [];
    let openDrain!: () => void;
    const drainGate = new Promise<void>((r) => (openDrain = r));
    const session = makeSession((scope) => {
      events.push("activate");
      scope.defer(async () => {
        events.push("drain-start");
        await drainGate;
        events.push("drain-end");
      });
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle(); // activate #1
    session.unsubscribe(ch); // idle → drain starts, blocks on drainGate
    await settle();
    session.subscribe(ch); // re-activate #2 — must serialize behind the drain
    await settle();
    expect(events).toEqual(["activate", "drain-start"]); // #2 not yet activated
    openDrain();
    await settle();
    expect(events).toEqual([
      "activate",
      "drain-start",
      "drain-end",
      "activate",
    ]);
  });

  it("runs the optional idle() hook AFTER the scope has fully drained", async () => {
    const order: string[] = [];
    const session = makeSession(
      (scope) => scope.defer(() => order.push("cleanup")),
      () => order.push("idle-hook"),
    );
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle();
    session.unsubscribe(ch);
    await session.drained();
    expect(order).toEqual(["cleanup", "idle-hook"]);
  });

  it("a throwing activate is caught (drain still works, no unhandled rejection)", async () => {
    const cleaned: string[] = [];
    const session = makeSession((scope) => {
      scope.defer(() => cleaned.push("before-throw"));
      throw new Error("boom");
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle();
    session.unsubscribe(ch);
    await session.drained();
    expect(cleaned).toEqual(["before-throw"]); // registered cleanup still drained
  });

  it("routes an activate() throw to the status banner, cleared on re-subscribe (value-sweep)", async () => {
    // A failing `activate()` used to console-`report()` only, leaving a dead
    // black view. It must now set the session's user-visible status error (the
    // A-P13 banner) and clear it on the next activation (retry-on-reactivate).
    let shouldFail = true;
    const session = defineResourceSession("res", contract, () => ({
      activate: () => {
        if (shouldFail) throw new Error("no camera");
      },
      commands: {},
    }));
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);
    let status: SessionStatus = { error: null, progress: null };
    client.on(topic.status("res"), (s: SessionStatus) => (status = s));

    session.subscribe(server);
    await settle();
    expect(status.error).toMatch(/no camera/);

    // Re-subscribe (the retry): clearError fires before the next activate.
    session.unsubscribe(server);
    await session.drained();
    shouldFail = false;
    session.subscribe(server);
    await settle();
    expect(status.error).toBeNull();
  });

  it("defer after supersession runs the cleanup immediately (no leak window)", async () => {
    const released: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const session = makeSession(async (scope) => {
      await gate; // still running when the session idles
      // Registered AFTER supersession → must run immediately, not linger.
      scope.defer(() => released.push("late"));
    });
    const ch = fakeChannel();
    session.subscribe(ch);
    await settle();
    session.unsubscribe(ch);
    await session.drained();
    openGate();
    await settle();
    expect(released).toEqual(["late"]);
  });
});
