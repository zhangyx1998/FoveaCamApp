// Per-session status channel (A-P13): a failed activation is surfaced as
// seeded, retry-clearable session status instead of stderr-only. Exercises
// `ServerSession.fail`/`clearError` + the seed-on-subscribe + activation-clear
// wiring over the fake endpoint pair.

import { describe, expect, it } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import {
  Channel,
  cmd,
  defineContract,
  topic,
  type SessionStatus,
} from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

const contract = defineContract({
  state: {},
  telemetry: { ready: false as boolean },
  frames: [] as const,
  commands: { ping: cmd<void, string>() },
});

function pair(): { client: Channel; server: Channel } {
  const [a, b] = createEndpointPair();
  return { client: new Channel(a), server: new Channel(b) };
}

function makeSession(hooks: { activate?: () => void; idle?: () => void } = {}) {
  return defineSession("cam", contract, () => ({
    commands: { async ping() { return "pong"; } },
    ...hooks,
  }));
}

/** Record every status payload the client channel receives. */
function watch(client: Channel): Array<string | null> {
  const seen: Array<string | null> = [];
  client.on(topic.status("cam"), (st: SessionStatus) => seen.push(st.error));
  return seen;
}

describe("session status channel (A-P13)", () => {
  it("seeds a null status on subscribe, then pushes fail() to subscribers", async () => {
    const s = makeSession();
    const p = pair();
    const seen = watch(p.client);
    s.subscribe(p.server);
    await flush();
    s.fail("Camera 42 is in use");
    await flush();
    expect(seen).toEqual([null, "Camera 42 is in use"]);
  });

  it("seeds the current error to a window that joins an already-failed active session", async () => {
    const s = makeSession();
    const first = pair();
    s.subscribe(first.server); // activates the session (a later re-activation clears)
    await flush();
    s.fail("boom");
    await flush();
    // A second window subscribes while the session stays active — no
    // re-activation, so the standing failure is seeded to it, not lost.
    const second = pair();
    const seen = watch(second.client);
    s.subscribe(second.server);
    await flush();
    expect(seen).toEqual(["boom"]);
  });

  it("clearError() resets and is a no-op when already clear", async () => {
    const s = makeSession();
    const p = pair();
    const seen = watch(p.client);
    s.subscribe(p.server);
    await flush();
    s.fail("x");
    await flush();
    seen.length = 0;
    s.clearError();
    await flush();
    expect(seen).toEqual([null]);
    seen.length = 0;
    s.clearError(); // already clear
    await flush();
    expect(seen).toEqual([]);
  });

  it("a fresh activation clears a stale error (retry-on-reactivate)", async () => {
    const s = makeSession({ activate: () => {} });
    const p = pair();
    const seen = watch(p.client);
    s.subscribe(p.server);
    await flush();
    s.fail("stale");
    await flush();
    s.unsubscribe(p.server); // idle — snapshot keeps the error
    await flush();
    seen.length = 0;
    s.subscribe(p.server); // re-seed (stale) then activation clears → null
    await flush();
    expect(seen).toContain(null);
    expect(seen[seen.length - 1]).toBe(null);
  });

  it("the deprecated error() alias now surfaces like fail()", async () => {
    const s = makeSession();
    const p = pair();
    const seen = watch(p.client);
    s.subscribe(p.server);
    await flush();
    s.error("legacy path");
    await flush();
    expect(seen).toContain("legacy path");
  });
});
