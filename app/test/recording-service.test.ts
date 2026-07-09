// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The composable recording facility (capture-recorder-everywhere ruling 1).
// Everything injected — the recorder node factory, the acquire config — so the
// start/stop lifecycle, the acquire-then-build ERROR-PATH unwind (mirrors
// multi-fovea-recording.test.ts's regression: a recorder-node throw releases
// EVERY acquired resource so a retry is clean), the poll telemetry, and the
// finished notification are proven without native core or a worker thread.
//
// Also pins the shape of the additive contract mixin (`recordingTelemetry` /
// `recordingCommands`) the renderer's `Recording` facade + title-bar
// RecordButton read.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createRecordingService,
  type RecordingAcquisition,
  type RecordingServiceConfig,
} from "@orchestrator/recording-service";
import type {
  RecorderNodeOptions,
  RecorderNodeHandle,
} from "@orchestrator/recorder-node";
import { recordingCommands, recordingTelemetry } from "@lib/orchestrator/contracts";

// --- fakes -------------------------------------------------------------------

interface FakeNode {
  options: RecorderNodeOptions;
  handle: RecorderNodeHandle;
  stopped: boolean;
}

function fakeNodeFactory() {
  const nodes: FakeNode[] = [];
  const createNode = (options: RecorderNodeOptions): RecorderNodeHandle => {
    const node: FakeNode = {
      options,
      stopped: false,
      handle: null as unknown as RecorderNodeHandle,
    };
    node.handle = {
      id: options.id,
      filePath: join(options.path, "recording.fovea"),
      stats: () => ({ s0: { frames: 3, dropped: 1, fps: 30, bytes: 100 } }),
      addStream: () => {},
      removeStream: () => {},
      addDataStream: () => {},
      removeDataStream: () => {},
      postData: () => {},
      stop: async () => {
        node.stopped = true;
        return { messageCount: "0", chunkCount: 0, bytes: 0 };
      },
    };
    nodes.push(node);
    return node.handle;
  };
  return { createNode, nodes };
}

const tmp = () => join(tmpdir(), `rec-svc-${Math.random().toString(36).slice(2)}`);

/** A config whose `acquire` logs release order into `released` and whose ready
 *  guard is toggleable. Two "resources" (`raw:0`, `raw:1`) so reverse-order
 *  release is observable. */
function makeConfig(overrides: Partial<RecordingServiceConfig> = {}) {
  const released: string[] = [];
  const telemetry: unknown[] = [];
  const finished: string[] = [];
  const config: RecordingServiceConfig = {
    id: "recorder/test",
    ready: () => true,
    telemetry: (patch) => void telemetry.push(patch),
    finished: (p) => void finished.push(p),
    acquire(): RecordingAcquisition {
      // Acquire two resources IN ORDER; release must run in REVERSE.
      released.length = 0;
      return {
        nodeOptions: { streams: { s0: { pipeId: "raw:0" } }, connect: () => ({}) as never },
        release: () => {
          released.push("raw:1");
          released.push("raw:0");
        },
      };
    },
    ...overrides,
  };
  return { config, released, telemetry, finished };
}

// --- tests ---------------------------------------------------------------------

describe("recording service facility", () => {
  it("refuses (false) when not ready, before any mkdir/acquire", async () => {
    const acquire = vi.fn();
    const { config } = makeConfig({ ready: () => false, acquire });
    const { createNode } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    expect(await svc.start(tmp())).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
    expect(svc.active).toBe(false);
  });

  it("refuses a blank path", async () => {
    const { config } = makeConfig();
    const { createNode } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    expect(await svc.start("   ")).toBe(false);
    expect(svc.active).toBe(false);
  });

  it("starts: builds the node, sets active, seeds telemetry, exposes the node", async () => {
    const { config, telemetry } = makeConfig();
    const { createNode, nodes } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    const dir = tmp();
    expect(await svc.start(dir)).toBe(true);
    expect(svc.active).toBe(true);
    expect(svc.node).toBe(nodes[0]!.handle);
    // Facility injects id/path/timestamp; app's node options ride through.
    expect(nodes[0]!.options.id).toBe("recorder/test");
    expect(nodes[0]!.options.path).toBe(dir);
    expect(typeof nodes[0]!.options.timestamp).toBe("string");
    expect(nodes[0]!.options.streams).toEqual({ s0: { pipeId: "raw:0" } });
    // First telemetry patch marks active + clears the stream table.
    expect(telemetry[0]).toEqual({ recording_active: true, recordingStreams: {} });
    await svc.stop();
  });

  it("second start while active is a no-op (false)", async () => {
    const { config } = makeConfig();
    const { createNode } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    expect(await svc.start(tmp())).toBe(true);
    expect(await svc.start(tmp())).toBe(false);
    await svc.stop();
  });

  it("stop finalizes, releases, notifies finished, then idle-safe", async () => {
    const { config, released, finished } = makeConfig();
    const { createNode, nodes } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    const dir = tmp();
    await svc.start(dir);
    expect(await svc.stop()).toBe(true);
    expect(nodes[0]!.stopped).toBe(true);
    // Released in REVERSE (last acquired first) — bricks-before-raw discipline.
    expect(released).toEqual(["raw:1", "raw:0"]);
    expect(finished).toEqual([join(dir, "recording.fovea")]);
    expect(svc.active).toBe(false);
    expect(svc.node).toBe(null);
    // A second stop is a no-op.
    expect(await svc.stop()).toBe(false);
  });

  it("runs onStarted (after active) + onStopped (after release)", async () => {
    const events: string[] = [];
    const { config } = makeConfig({
      onStarted: (node) => events.push(`started:${node.id}`),
      onStopped: () => events.push("stopped"),
    });
    const { createNode } = fakeNodeFactory();
    const svc = createRecordingService({ ...config, createNode });
    await svc.start(tmp());
    await svc.stop();
    expect(events).toEqual(["started:recorder/test", "stopped"]);
  });

  it("releases every acquired resource when the recorder node throws at start (retry clean)", async () => {
    // A throw during the recorder-node build (worker spawn / broker connect)
    // must release ALL acquired resources — else the orphaned refcount never
    // unadvertises (camera-exclusivity hazard) and a retry double-refcounts.
    const { createNode } = fakeNodeFactory();
    let armed = true;
    const { config, released } = makeConfig();
    const svc = createRecordingService({
      ...config,
      createNode: (opts) => {
        if (armed) {
          armed = false;
          throw new Error("boom: recorder worker spawn failed");
        }
        return createNode(opts);
      },
    });
    await expect(svc.start(tmp())).rejects.toThrow("boom");
    // Released in reverse — no orphaned resource, controller left idle.
    expect(released).toEqual(["raw:1", "raw:0"]);
    expect(svc.active).toBe(false);
    expect(svc.node).toBe(null);
    // A retry re-acquires + builds cleanly.
    expect(await svc.start(tmp())).toBe(true);
    await svc.stop();
  });

  it("polls the node's stats into recordingStreams", async () => {
    vi.useFakeTimers();
    try {
      const { config, telemetry } = makeConfig({ pollMs: 10 });
      const { createNode } = fakeNodeFactory();
      const svc = createRecordingService({ ...config, createNode });
      await svc.start(tmp());
      telemetry.length = 0;
      await vi.advanceTimersByTimeAsync(25);
      // At least one poll landed with the node's stats.
      expect(telemetry).toContainEqual({
        recordingStreams: { s0: { frames: 3, dropped: 1, fps: 30, bytes: 100 } },
      });
      await svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recording contract mixin", () => {
  it("recordingTelemetry() has the RecordButton-facade shape", () => {
    const t = recordingTelemetry();
    expect(t).toEqual({ recording_active: false, recordingStreams: {} });
  });

  it("recordingCommands() exposes startRecording + stopRecording", () => {
    const c = recordingCommands();
    expect(Object.keys(c).sort()).toEqual(["startRecording", "stopRecording"]);
  });
});
