// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// `createVisionWorker` (C-22b) message routing — the main-side half of the
// per-session vision worker, unit-tested with an injected fake worker (the real
// worker file is a build-gated bundle; the integration test that spawns it
// gates on A-28 + B-19c). Verifies: init post shape, result→onResult routing,
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
});
