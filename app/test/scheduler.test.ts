import { describe, expect, it, vi } from "vitest";
import {
  RoundRobinFrameScheduler,
  type FrameRequest,
  type FrameRequestPromise,
} from "@orchestrator/scheduler";
import type { FrameOutcome } from "@orchestrator/controller";

class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeRequester {
  calls: Array<{
    request: FrameRequest;
    accepted: Deferred<unknown>;
    finished: Deferred<FrameOutcome>;
  }> = [];

  frame(request: FrameRequest): FrameRequestPromise {
    const accepted = new Deferred<unknown>();
    const finished = new Deferred<FrameOutcome>();
    this.calls.push({ request, accepted, finished });
    return Object.assign(finished.promise, { accepted: accepted.promise });
  }
}

const outcome = (stream: number): FrameOutcome => ({
  stream,
  tTrigger: 1n,
  tExposure: 2n,
  left: { x: stream, y: 0 },
  right: { x: stream, y: 0 },
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("RoundRobinFrameScheduler", () => {
  it("keeps at most K requests in flight and rotates fairly", async () => {
    const requester = new FakeRequester();
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: [0, 1, 2, 3].map((stream) => ({ stream })),
      maxInFlight: 2,
      acceptedTimeoutMs: 0,
      completionTimeoutMs: 0,
    });

    scheduler.start();
    expect(requester.calls.map((c) => c.request.stream)).toEqual([0, 1]);
    expect(scheduler.activeRequestCount).toBe(2);

    requester.calls[0].finished.resolve(outcome(0));
    await flush();
    expect(requester.calls.map((c) => c.request.stream)).toEqual([0, 1, 2]);

    requester.calls[1].finished.resolve(outcome(1));
    await flush();
    expect(requester.calls.map((c) => c.request.stream)).toEqual([0, 1, 2, 3]);
    expect(scheduler.activeRequestCount).toBe(2);
  });

  it("honors per-stream pacing without starving other streams", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requester = new FakeRequester();
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: [0, 1, 2].map((stream) => ({ stream })),
      maxInFlight: 1,
      defaultMinIntervalMs: 10,
      acceptedTimeoutMs: 0,
      completionTimeoutMs: 0,
      now: () => Date.now(),
    });

    scheduler.start();
    for (let i = 0; i < 3; i++) {
      requester.calls[i].finished.resolve(outcome(requester.calls[i].request.stream));
      await flush();
    }
    expect(requester.calls.map((c) => c.request.stream)).toEqual([0, 1, 2]);

    await vi.advanceTimersByTimeAsync(9);
    expect(requester.calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(requester.calls.map((c) => c.request.stream)).toEqual([0, 1, 2, 0]);
    vi.useRealTimers();
  });

  it("tolerates duplicate REJ storms and requeues instead of surfacing an error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requester = new FakeRequester();
    const onError = vi.fn();
    const onReject = vi.fn();
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: [{ stream: 7 }],
      maxInFlight: 1,
      retryDelayMs: 5,
      acceptedTimeoutMs: 0,
      completionTimeoutMs: 0,
      now: () => Date.now(),
      onReject,
      onError,
    });

    scheduler.start();
    requester.calls[0].accepted.reject(new Error("duplicate stream pending"));
    await flush();
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);
    expect(requester.calls.map((c) => c.request.stream)).toEqual([7, 7]);
    vi.useRealTimers();
  });

  it("times out slow FINs and requeues the stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requester = new FakeRequester();
    const onTimeout = vi.fn();
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: [{ stream: 2 }],
      maxInFlight: 1,
      retryDelayMs: 1,
      acceptedTimeoutMs: 0,
      completionTimeoutMs: 10,
      now: () => Date.now(),
      onTimeout,
    });

    scheduler.start();
    requester.calls[0].accepted.resolve(undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requester.calls.map((c) => c.request.stream)).toEqual([2, 2]);
    vi.useRealTimers();
  });
});
