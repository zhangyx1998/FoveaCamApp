// value-sweep-2026-07-11: the renderer error tray
// (`error-broadcast-dead-ends-in-console`) + the `useSession().call()` default
// rejection surface (`fire-and-forget-command-calls-drop-rejections`).
//
// `client.ts` runs DOM-only code at import (it registers a `window.foveaBridge`
// down-report hook and a keydown listener at module scope), so a minimal
// `window` is stubbed BEFORE the dynamic import. `connect()` is then driven
// through a fake MessagePort pair (the DOM `onmessage`/`postMessage` shape a
// real `Channel` wraps) so a rejecting command round-trips end to end.

import { beforeAll, afterEach, describe, expect, it } from "vitest";
import {
  Channel,
  cmd,
  defineContract,
  topic,
  type Endpoint,
} from "@lib/orchestrator/protocol";

// --- minimal DOM window (must exist before client.ts is imported) -----------
const listeners: Record<string, Array<(e: unknown) => void>> = {};
const win = {
  addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
  removeEventListener: (t: string, f: (e: unknown) => void) => {
    const a = listeners[t];
    if (a) a.splice(a.indexOf(f), 1);
  },
  dispatch: (t: string, e: unknown) => (listeners[t] ?? []).slice().forEach((f) => f(e)),
  postMessage: () => {},
  foveaBridge: {
    onOrchestratorDown: () => {},
    connectOrchestrator: () => {},
    writePerfSnapshot: async () => "",
    openProfilerWindow: () => {},
  },
};
(globalThis as unknown as { window: typeof win }).window = win;

// A fake DOM `MessagePort` pair — `onmessage`/`postMessage(data, transfer?)`,
// async delivery like the real thing.
type DomPort = {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown, transfer?: unknown[]): void;
  start(): void;
  close(): void;
};
function domPortPair(): [DomPort, DomPort] {
  const a: DomPort = { onmessage: null, postMessage: () => {}, start() {}, close() {} };
  const b: DomPort = { onmessage: null, postMessage: () => {}, start() {}, close() {} };
  a.postMessage = (d) => queueMicrotask(() => b.onmessage?.({ data: d }));
  b.postMessage = (d) => queueMicrotask(() => a.onmessage?.({ data: d }));
  return [a, b];
}

let client: typeof import("@lib/orchestrator/client");
beforeAll(async () => {
  client = await import("@lib/orchestrator/client");
});
afterEach(() => client.clearErrors());

describe("error tray ring (value-sweep)", () => {
  it("coalesces a repeated scope+message into a front-of-ring count bump", () => {
    client.reportToTray("cam", "boom");
    client.reportToTray("cam", "boom");
    client.reportToTray("rec", "other");
    expect(client.errorTray).toHaveLength(2);
    const boom = client.errorTray.find((r) => r.scope === "cam")!;
    expect(boom.count).toBe(2);
    // A later repeat bumps the count AND moves it back to the front.
    client.reportToTray("cam", "boom");
    expect(client.errorTray[0].scope).toBe("cam");
    expect(client.errorTray[0].count).toBe(3);
  });

  it("dismisses one report and clears the rest", () => {
    client.reportToTray("a", "1");
    client.reportToTray("b", "2");
    client.dismissError(client.errorTray[0]);
    expect(client.errorTray).toHaveLength(1);
    client.clearErrors();
    expect(client.errorTray).toHaveLength(0);
  });

  it("bounds the ring and keeps newest-first order", () => {
    for (let i = 0; i < 60; i++) client.reportToTray("s", `m${i}`);
    expect(client.errorTray.length).toBeLessThanOrEqual(50);
    expect(client.errorTray[0].message).toBe("m59");
  });
});

describe("useSession().call() default rejection surface (value-sweep)", () => {
  it("surfaces a command rejection to the tray AND still rejects for an explicit catch", async () => {
    const contract = defineContract({
      state: {},
      telemetry: {},
      frames: [] as const,
      commands: { boom: cmd<void, void>() },
    });
    const session = client.useSession(contract, "sess");

    // Feed a fake orchestrator port so `connect()` (hence `call`'s `ready`)
    // resolves, with a server Channel that rejects the `boom` command.
    const [clientPort, serverPort] = domPortPair();
    const serverEp: Endpoint = {
      post: (d) => serverPort.postMessage(d),
      onMessage: (cb) => {
        serverPort.onmessage = (e) => cb(e.data);
      },
      close: () => serverPort.close(),
    };
    const server = new Channel(serverEp);
    server.handle(topic.command("sess", "boom"), () => {
      throw new Error("kaboom");
    });
    win.dispatch("message", { data: "orchestrator:port", ports: [clientPort] });

    // The explicit `.catch` still runs (double-surface: control flow preserved).
    let caught: unknown;
    await session.call("boom", undefined).catch((e) => (caught = e));
    expect((caught as Error).message).toMatch(/kaboom/);

    // ...and the rejection ALSO landed in the tray at the one chokepoint.
    expect(client.errorTray).toHaveLength(1);
    expect(client.errorTray[0].scope).toBe("sess");
    expect(client.errorTray[0].message).toMatch(/boom:.*kaboom/);
  });
});
