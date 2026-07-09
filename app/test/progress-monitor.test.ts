// Orchestrator spin-up progress monitor (user ruling 2026-07-09): a session
// declares its activation steps upfront and transitions each one as the graph
// builds, riding the per-session STATUS channel so any window can render a
// progress overlay instead of blanking. This exercises `ServerSession
// .progressMonitor` publish shapes (declare → pending, start → active, done →
// done, complete → null), seed-on-late-subscribe, idle reset, and the frozen-
// on-fail contract, over the fake endpoint pair — the same harness
// `session-status.test.ts` uses.

import { describe, expect, it } from "vitest";
import { defineSession } from "@orchestrator/runtime";
import {
  Channel,
  defineContract,
  topic,
  type SessionStatus,
} from "@lib/orchestrator/protocol";
import type { ProgressItem } from "@lib/orchestrator/progress";
import { createEndpointPair, flush } from "./fake-endpoint";

const contract = defineContract({
  state: {},
  telemetry: {},
  frames: [] as const,
  commands: {},
});

function pair(): { client: Channel; server: Channel } {
  const [a, b] = createEndpointPair();
  return { client: new Channel(a), server: new Channel(b) };
}

function makeSession(
  hooks: { activate?: () => void; idle?: () => void } = {},
) {
  return defineSession("cam", contract, () => ({ commands: {}, ...hooks }));
}

/** Record every `progress` payload the client channel receives. */
function watchProgress(client: Channel): Array<ProgressItem[] | null> {
  const seen: Array<ProgressItem[] | null> = [];
  client.on(topic.status("cam"), (st: SessionStatus) => seen.push(st.progress));
  return seen;
}

const STEPS = [
  { id: "a", label: "Step A" },
  { id: "b", label: "Step B" },
];

describe("orchestrator spin-up progress monitor (ruling 2026-07-09)", () => {
  it("declare publishes the full pending list; start/done publish transitions; complete clears", async () => {
    const s = makeSession();
    const p = pair();
    const seen = watchProgress(p.client);
    s.subscribe(p.server);
    await flush(); // seed: progress null

    const mon = s.progressMonitor(STEPS);
    await flush();
    mon.start("a");
    await flush();
    mon.done("a");
    await flush();
    mon.complete();
    await flush();

    expect(seen).toEqual([
      null, // seed on subscribe
      [
        { id: "a", label: "Step A", state: "pending" },
        { id: "b", label: "Step B", state: "pending" },
      ],
      [
        { id: "a", label: "Step A", state: "active" },
        { id: "b", label: "Step B", state: "pending" },
      ],
      [
        { id: "a", label: "Step A", state: "done" },
        { id: "b", label: "Step B", state: "pending" },
      ],
      null, // complete()
    ]);
  });

  it("seeds the in-flight progress list to a window that joins mid-spin-up", async () => {
    const s = makeSession({ activate: () => {} });
    const active = pair();
    s.subscribe(active.server); // activates the session
    await flush();
    const mon = s.progressMonitor(STEPS);
    mon.start("a");
    await flush();

    // A second window opens WHILE spin-up is in flight — it must be seeded the
    // current list, not a blank screen (the whole point of the seed-on-subscribe).
    const late = pair();
    const seen = watchProgress(late.client);
    s.subscribe(late.server, { passive: true });
    await flush();

    expect(seen).toEqual([
      [
        { id: "a", label: "Step A", state: "active" },
        { id: "b", label: "Step B", state: "pending" },
      ],
    ]);
  });

  it("idle teardown resets progress to null (no stale overlay for the next spin-up)", async () => {
    const s = makeSession({ activate: () => {} });
    const active = pair();
    const observer = pair();
    const seen = watchProgress(observer.client);
    // Passive observer stays subscribed across the active window's teardown, so
    // it can witness the idle reset broadcast (the active channel is dropped
    // from `subscribers` before `runIdle`, so it never sees its own reset).
    s.subscribe(observer.server, { passive: true });
    s.subscribe(active.server);
    await flush();
    s.progressMonitor(STEPS);
    await flush();
    seen.length = 0;

    s.unsubscribe(active.server); // last active → runIdle resets progress
    await flush();
    expect(seen).toEqual([null]);
  });

  it("a superseded monitor handle is inert — late transitions cannot resurrect or clobber", async () => {
    const s = makeSession({ activate: () => {} });
    const active = pair();
    const observer = pair();
    const seen = watchProgress(observer.client);
    s.subscribe(observer.server, { passive: true });
    s.subscribe(active.server);
    await flush();

    // First activation declares, then is superseded (idle clears)…
    const stale = s.progressMonitor(STEPS);
    s.unsubscribe(active.server); // runIdle → progress null, handle orphaned
    await flush();

    // …a NEW activation declares its own list…
    s.subscribe(active.server);
    await flush();
    s.progressMonitor([{ id: "x", label: "Step X" }]);
    await flush();
    seen.length = 0;

    // …and the stale handle fires late, past an await in the dead activation.
    stale.done("a");
    stale.complete();
    await flush();
    expect(seen).toEqual([]); // inert: no publish, no clobber
  });

  it("fail() leaves the progress list frozen (the error surfaces separately)", async () => {
    const s = makeSession();
    const p = pair();
    const seen: SessionStatus[] = [];
    p.client.on(topic.status("cam"), (st: SessionStatus) => seen.push(st));
    s.subscribe(p.server);
    await flush();
    const mon = s.progressMonitor(STEPS);
    mon.start("a");
    await flush();

    s.fail("Camera 42 is in use");
    await flush();

    const last = seen[seen.length - 1];
    expect(last.error).toBe("Camera 42 is in use");
    // The list is UNCHANGED — a frozen "Step A active" shows WHERE it died.
    expect(last.progress).toEqual([
      { id: "a", label: "Step A", state: "active" },
      { id: "b", label: "Step B", state: "pending" },
    ]);
  });
});
