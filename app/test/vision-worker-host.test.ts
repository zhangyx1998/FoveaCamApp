// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `createVisionWorker` message routing — the main-side half of the
// per-session vision worker, unit-tested with an injected fake worker (the real
// worker file is a build-gated bundle, spawned by a separate integration
// test). Verifies: init post shape, result→onResult routing,
// param/stop posts, terminate idempotence + no-post-after-terminate.

import { describe, it, expect, vi } from "vitest";
import {
  createVisionWorker,
  type WorkerLike,
} from "@orchestrator/vision-worker-host";
import type {
  VisionWorkerOut,
  VisionResult,
} from "@orchestrator/vision-worker-protocol";

class FakeWorker implements WorkerLike {
  posted: { msg: unknown; transfer?: readonly unknown[] }[] = [];
  terminated = 0;
  private handlers: Partial<Record<string, (arg: never) => void>> = {};

  postMessage(msg: unknown, transfer?: readonly unknown[]): void {
    this.posted.push({ msg, transfer });
  }
  on(event: string, cb: (arg: never) => void): void {
    this.handlers[event] = cb;
  }
  terminate(): void {
    this.terminated++;
  }
  emit(event: "message", msg: VisionWorkerOut): void;
  emit(event: "error", err: Error): void;
  emit(event: "exit", code: number): void;
  emit(event: string, arg: unknown): void {
    (this.handlers[event] as ((a: unknown) => void) | undefined)?.(arg);
  }
}

const init = {
  pipes: [
    { role: "C" as const, shmName: "/fv.cam.C", width: 640, height: 480, channels: 4, bytesPerFrame: 640 * 480 * 4 },
  ],
  params: { kind: "disparity", zoom: 9 },
};

describe("createVisionWorker (C-22b host)", () => {
  it("posts a fully-formed init message with the resolved reader path", () => {
    const fake = new FakeWorker();
    createVisionWorker(init, () => {}, { spawn: () => fake, readerPath: "/x/reader.node" });
    expect(fake.posted).toHaveLength(1);
    const msg = fake.posted[0]!.msg as Record<string, unknown>;
    expect(msg.kind).toBe("init");
    expect(msg.readerPath).toBe("/x/reader.node");
    expect(msg.pipes).toEqual(init.pipes);
    expect(msg.params).toEqual(init.params);
  });

  it("routes result messages to onResult", () => {
    const fake = new FakeWorker();
    const onResult = vi.fn();
    createVisionWorker(init, onResult, { spawn: () => fake, readerPath: "/x" });
    const result: VisionResult = { kind: "result", values: { seq: 7 }, frames: [] };
    fake.emit("message", result);
    expect(onResult).toHaveBeenCalledWith(result);
  });

  it("does not route error messages to onResult", () => {
    const fake = new FakeWorker();
    const onResult = vi.fn();
    createVisionWorker(init, onResult, { spawn: () => fake, readerPath: "/x" });
    fake.emit("message", { kind: "error", message: "boom" });
    expect(onResult).not.toHaveBeenCalled();
  });

  it("sendParams posts a params message", () => {
    const fake = new FakeWorker();
    const h = createVisionWorker(init, () => {}, { spawn: () => fake, readerPath: "/x" });
    h.sendParams({ zoom: 5 });
    expect(fake.posted[1]!.msg).toEqual({ kind: "params", params: { zoom: 5 } });
  });

  it("terminate posts stop, terminates once, and blocks later posts", () => {
    const fake = new FakeWorker();
    const h = createVisionWorker(init, () => {}, { spawn: () => fake, readerPath: "/x" });
    h.terminate();
    expect(fake.posted.at(-1)!.msg).toEqual({ kind: "stop" });
    expect(fake.terminated).toBe(1);
    const postCount = fake.posted.length;
    h.terminate(); // idempotent
    h.sendParams({ zoom: 1 }); // dropped after terminate
    expect(fake.terminated).toBe(1);
    expect(fake.posted).toHaveLength(postCount);
  });

  it("stops posting once the worker exits", () => {
    const fake = new FakeWorker();
    const h = createVisionWorker(init, () => {}, { spawn: () => fake, readerPath: "/x" });
    const postCount = fake.posted.length;
    fake.emit("exit", 0);
    h.sendParams({ zoom: 2 });
    expect(fake.posted).toHaveLength(postCount);
  });

  // Without a meter, a kernel-bound worker (disparity at ~35fps vs 60fps
  // cameras) is INVISIBLE in the profiler. With
  // `meterName`, the worker's posted stats rows are served as a native-probe
  // source (staleness-gated, disposed with the worker).
  it("serves posted stats rows as a probe while alive (meterName)", async () => {
    const { nativeProbes } = await import("@orchestrator/native-probes");
    const fake = new FakeWorker();
    const h = createVisionWorker(
      { ...init, meterName: "win/disparity-scope/disparity" },
      () => {},
      { spawn: () => fake, readerPath: "/x" },
    );
    expect(nativeProbes()["win/disparity-scope/disparity"]).toBeUndefined();
    const workload = {
      name: "win/disparity-scope/disparity",
      window: { startedAt: 0, snapshotAt: 1000, uptimeMs: 1000 },
      utilization: 0.9,
      busyMs: 900,
      inputs: { L: { count: 35, ratePerSec: 35 } },
      outputs: { result: { count: 35, ratePerSec: 35, maxIntervalMs: 40 } },
      drops: { total: 25, ratePerSec: 25, byReason: {} },
    };
    fake.emit("message", { kind: "stats", workload } as never);
    expect(nativeProbes()["win/disparity-scope/disparity"]).toMatchObject({
      utilization: 0.9,
      drops: { total: 25 },
    });
    h.terminate(); // probe disposed with the worker — no ghost rows
    expect(nativeProbes()["win/disparity-scope/disparity"]).toBeUndefined();
  });

  it("registers no probe without meterName", async () => {
    const { nativeProbes } = await import("@orchestrator/native-probes");
    const fake = new FakeWorker();
    const before = Object.keys(nativeProbes()).length;
    createVisionWorker(init, () => {}, { spawn: () => fake, readerPath: "/x" });
    fake.emit("message", {
      kind: "stats",
      workload: { name: "ghost" },
    } as never);
    expect(Object.keys(nativeProbes()).length).toBe(before);
  });
});
