import { beforeEach, describe, expect, it, vi } from "vitest";
import { Channel, topic, type FrameTopicStats } from "@lib/orchestrator/protocol";
import { createEndpointPair, flush } from "./fake-endpoint";

vi.mock("@orchestrator/camera", () => ({
  listCameraInfo: vi.fn(async () => []),
}));

vi.mock("@orchestrator/registry", () => ({
  releaseAll: vi.fn(async () => undefined),
}));

vi.mock("@orchestrator/store-hub", () => ({
  writeCounts: vi.fn(() => ({ writes: 1, updates: 2, clears: 3 })),
  attachStore: vi.fn(() => () => undefined),
}));

let activeController: any = null;

vi.mock("@orchestrator/controller", () => ({
  activeController: () => activeController,
  setActiveController: (c: any) => {
    activeController = c;
  },
  Controller: class {
    static match = vi.fn(async () => ({ path: "fake" }));
    ready = Promise.resolve();
    connected = true;
    enabled = false;
    dv = 170;
    pos = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    stats = { txBytes: 0, rxBytes: 0, txPackets: 0, rxPackets: 0 };
    streamSnapshot = vi.fn(() => []);
  },
}));

function frameStats(): Record<string, FrameTopicStats> {
  return {
    "fr:x:y": {
      offered: 2,
      sent: 1,
      coalesced: 1,
      bytes: 16,
      window: { startedAt: 100, snapshotAt: 1100, uptimeMs: 1000 },
      rates: { offeredPerSec: 2, sentPerSec: 1, coalescedPerSec: 1, bytesPerSec: 16 },
      timing: { convertMs: { count: 1, mean: 3, max: 3 } },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  activeController = null;
});

describe("perf substrate timers and snapshots", () => {
  it("RollingStats resetMax clears only the window max, not the rolling mean", async () => {
    const { RollingStats } = await import("@lib/util/rolling");
    const stats = new RollingStats(0.5, 2, "ms");
    stats.push(10);
    stats.push(20);
    expect(stats.max).toBe(20);
    expect(stats.mean).toBeGreaterThan(0);

    stats.resetMax();
    expect(stats.max).toBe(0);
    expect(stats.mean).toBeGreaterThan(0);
  });

  it("system loop-lag telemetry publishes at most once per second", async () => {
    const { systemSession } = await import("@orchestrator/sessions/system");
    const session = systemSession(() => [], frameStats);
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);

    const telemetry: any[] = [];
    client.on(topic.telemetry("system"), (patch) => telemetry.push(patch));
    session.subscribe(server);
    await flush();
    const seeded = telemetry.length;

    await vi.advanceTimersByTimeAsync(999);
    expect(telemetry).toHaveLength(seeded);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(telemetry).toHaveLength(seeded + 1);
  });

  it("system perfSnapshot keeps the additive frame timing/window shape stable", async () => {
    const { systemSession } = await import("@orchestrator/sessions/system");
    const session = systemSession(() => [], frameStats);
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);

    const snapshot = await client.request(topic.command("system", "perfSnapshot"));
    expect(snapshot).toMatchObject({
      timestamp: expect.any(String),
      orchestrator: { loopLag: { mean: expect.any(Number), max: expect.any(Number) } },
      storeHub: { writes: 1, updates: 2, clears: 3 },
      frames: {
        "fr:x:y": {
          window: { uptimeMs: 1000 },
          rates: { sentPerSec: 1 },
          timing: { convertMs: { count: 1, mean: 3, max: 3 } },
        },
      },
      spans: expect.any(Array),
    });
  });

  it("controller serial/stream telemetry publishes on the 500 ms probe cadence", async () => {
    const { controllerSession } = await import("@orchestrator/sessions/controller");
    const session = controllerSession();
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);
    session.subscribe(server);

    const telemetry: any[] = [];
    client.on(topic.telemetry("controller"), (patch) => telemetry.push(patch));
    await client.request(topic.command("controller", "connect"));
    await flush();
    const beforeProbe = telemetry.length;

    await vi.advanceTimersByTimeAsync(499);
    expect(telemetry).toHaveLength(beforeProbe);
    activeController.stats = { txBytes: 10, rxBytes: 20, txPackets: 1, rxPackets: 2 };
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(telemetry.length).toBe(beforeProbe + 1);
    expect(telemetry.at(-1)).toMatchObject({
      serialRate: {
        txBytesPerSec: expect.any(Number),
        rxBytesPerSec: expect.any(Number),
      },
      streams: [],
    });
  });
});
