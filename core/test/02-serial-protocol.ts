#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { SerialPort } from "serialport";
import {
  type ActuateArg,
  type AnalogChannels,
  Device,
  Protocol,
} from "core/Controller";

type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];
type Pos = { x: number; y: number };
type MaybeTwoPhase<T, A = T> = Promise<T> & { accepted?: Promise<A> };
type PromiseOutcome<T> = {
  phase: string;
  status: "fulfilled" | "rejected";
  elapsedMs: number;
  value?: T;
  error?: unknown;
};

const biasVolt = 90;
const motionDurationMs = 2_000;
const motionIntervalMs = 1;
const commandTimeoutMs = 100;
const amplitude = 170;
const streamId = 0;

class CommandTimeout extends Error {
  elapsedMs: number;
  phase: string;

  constructor(elapsedMs: number, phase = "command") {
    super(`${phase} timed out after ${elapsedMs} ms`);
    this.elapsedMs = elapsedMs;
    this.phase = phase;
  }
}

async function getPort(match: Partial<PortInfo>) {
  for (const port of await SerialPort.list()) {
    if (
      Object.entries(match).every(([k, v]) => port[k as keyof PortInfo] === v)
    )
      return port;
  }
  return null;
}

function clamp(val: number, min: number, max: number) {
  return val < min ? min : val > max ? max : val;
}

function volt2dac(volt: number) {
  return clamp((65535 * volt) / 200, 0, 65535) | 0;
}

function dac2volt(dac: number) {
  return (200 * dac) / 65535;
}

function channelPair(volt: number, bias = biasVolt, maxDelta = amplitude / 2) {
  const v = clamp(volt / 2, -maxDelta, maxDelta);
  return [volt2dac(bias + v), volt2dac(bias - v)] as const;
}

function channels(pos: Pos): AnalogChannels {
  return [...channelPair(pos.x), ...channelPair(pos.y)];
}

function positionAt(dt: number) {
  const t = clamp(dt / motionDurationMs, 0, 1);
  if (t <= 0.25) return amplitude * (t / 0.25);
  if (t <= 0.75) return amplitude * (1 - ((t - 0.25) / 0.5) * 2);
  return -amplitude * (1 - (t - 0.75) / 0.25);
}

function summarize(samples: number[]) {
  if (!samples.length) return null;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance =
    samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  return { min, max, mean, stddev: Math.sqrt(variance) };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  phase?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandTimeout(ms, phase)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function observePromise<T>(
  phase: string,
  promise: Promise<T>,
  started: number,
): Promise<PromiseOutcome<T>> {
  return promise.then(
    (value) => {
      const outcome: PromiseOutcome<T> = {
        phase,
        status: "fulfilled",
        elapsedMs: performance.now() - started,
        value,
      };
      console.log("Motion promise settled:", {
        phase: outcome.phase,
        status: outcome.status,
        elapsed_ms: outcome.elapsedMs,
      });
      return outcome;
    },
    (error) => {
      const outcome: PromiseOutcome<T> = {
        phase,
        status: "rejected",
        elapsedMs: performance.now() - started,
        error,
      };
      console.log("Motion promise settled:", {
        phase: outcome.phase,
        status: outcome.status,
        elapsed_ms: outcome.elapsedMs,
        error,
      });
      return outcome;
    },
  );
}

const stats = {
  commandAcceptedLatencyMs: [] as number[],
  commandCompletionLatencyMs: [] as number[],
  iterationGapMs: [] as number[],
  commandCompleteTimeUs: [] as number[],
  commandedPosition: [] as number[],
};

function reportStats(elapsedMs: number, updates: number) {
  console.log("Motion statistics:", {
    duration_ms: elapsedMs,
    updates,
    update_rate_hz: updates / (elapsedMs / 1_000),
    command_accepted_latency_ms: summarize(stats.commandAcceptedLatencyMs),
    command_completion_latency_ms: summarize(stats.commandCompletionLatencyMs),
    iteration_gap_ms: summarize(stats.iterationGapMs),
    command_complete_time_us: summarize(stats.commandCompleteTimeUs),
    commanded_position: summarize(stats.commandedPosition),
  });
}

async function runMotion(
  device: Device,
  v: number,
  settle_time = 10_000,
  timeoutMs = commandTimeoutMs,
) {
  const left = channels({ x: v, y: v });
  const right = channels({ x: -v, y: v });
  const started = performance.now();
  const request = device.set(Protocol.Command.Actuate, {
    left,
    right,
    settle_time,
  }) as MaybeTwoPhase<ActuateArg>;
  const acceptedType = typeof request.accepted;
  console.log("Motion request promises:", { accepted_type: acceptedType });
  if (device.v2Capable && acceptedType !== "object")
    throw new Error("v2 ACTUATE promise is missing .accepted");

  const completed = observePromise("completed", request, started);
  const accepted = request.accepted
    ? observePromise("accepted", request.accepted, started)
    : null;
  const first = await withTimeout(
    Promise.race(accepted ? [accepted, completed] : [completed]),
    timeoutMs,
    "ACTUATE first settlement",
  );
  console.log("Motion first promise settled:", {
    phase: first.phase,
    status: first.status,
    elapsed_ms: first.elapsedMs,
  });
  if (first.status === "rejected") throw first.error;

  const completedOutcome =
    first.phase === "completed"
      ? (first as PromiseOutcome<ActuateArg>)
      : await withTimeout(completed, timeoutMs, "ACTUATE FIN");
  if (completedOutcome.status === "rejected") throw completedOutcome.error;
  const response = completedOutcome.value;
  if (!response) throw new Error("ACTUATE completed without a value");

  return {
    left: [
      dac2volt(response.left[0] - response.left[1]),
      dac2volt(response.left[2] - response.left[3]),
    ],
    right: [
      dac2volt(response.right[0] - response.right[1]),
      dac2volt(response.right[2] - response.right[3]),
    ],
    accepted_ms:
      accepted && first.phase === "accepted" ? first.elapsedMs : null,
    completed_ms: completedOutcome.elapsedMs,
    complete_time: response.complete_time,
  };
}

async function smokeV2StreamApi(device: Device) {
  if (!device.v2Capable) {
    console.log(
      "Skipping v2 stream API smoke test: firmware is not v2-capable.",
    );
    return;
  }

  const zero = channels({ x: 0, y: 0 });
  let created = false;
  await device.set(Protocol.Command.MirrorStream, {
    op: "CREATE",
    id: streamId,
    left: zero,
    right: zero,
  });
  created = true;
  try {
    device.fireAndForget(Protocol.Command.MirrorStream, {
      op: "UPDATE",
      id: streamId,
      left: channels({ x: 10, y: 0 }),
      right: channels({ x: -10, y: 0 }),
    });
  } finally {
    if (created)
      await device.set(Protocol.Command.MirrorStream, {
        op: "TERMINATE",
        id: streamId,
      });
  }

  console.log("v2 stream API smoke test passed.");
}

const info = await getPort({ vendorId: "16c0", productId: "0483" });
if (!info) {
  console.error("Device not found, did you plug it in?");
  process.exit(1);
}

console.log("Device found:", info);
const device = new Device(info.path);

try {
  await device.set(Protocol.System.Enable, false);
  const version = await device.verifyVersion();
  console.log("Controller:", {
    info: await device.get(Protocol.System.Info),
    version,
    v2Capable: device.v2Capable,
  });
  console.log(await device.set(Protocol.Config.Log, "INFO"));
  console.log(await device.set(Protocol.Config.Bias, volt2dac(biasVolt)));
  console.log(await device.set(Protocol.Config.LPF, 120));

  console.log(await device.set(Protocol.System.Enable, true));
  await smokeV2StreamApi(device);
  let updates = 0;
  let lastIterationStart: number | null = null;
  const motionStart = performance.now();
  const motionDeadline = motionStart + motionDurationMs;
  let nextTick = motionStart;

  while (performance.now() < motionDeadline) {
    const waitMs = nextTick - performance.now();
    if (waitMs > 0) await sleep(waitMs);

    const iterationStart = performance.now();
    if (iterationStart >= motionDeadline) break;

    if (lastIterationStart !== null)
      stats.iterationGapMs.push(iterationStart - lastIterationStart);
    lastIterationStart = iterationStart;

    const position = positionAt(iterationStart - motionStart);
    stats.commandedPosition.push(position);

    let response: Awaited<ReturnType<typeof runMotion>>;
    try {
      response = await runMotion(device, position, 0);
    } catch (error) {
      if (error instanceof CommandTimeout) {
        console.log("Motion command timed out; stopping loop early.", {
          phase: error.phase,
          elapsed_ms: performance.now() - motionStart,
          updates,
          position,
        });
        break;
      }
      throw error;
    }
    if (response.accepted_ms !== null)
      stats.commandAcceptedLatencyMs.push(response.accepted_ms);
    stats.commandCompletionLatencyMs.push(response.completed_ms);
    if (response.complete_time !== undefined)
      stats.commandCompleteTimeUs.push(response.complete_time);
    updates++;
    nextTick += motionIntervalMs;
  }

  const motionEnd = performance.now();
  try {
    await runMotion(device, 0, 0, 500);
  } catch (error) {
    console.log("Failed to return mirrors to origin:", error);
  }
  reportStats(motionEnd - motionStart, updates);
  console.log("Loop finished");
} catch (error) {
  console.error("Error occurred:", error);
} finally {
  try {
    await device.set(Protocol.System.Enable, false);
  } catch (error) {
    console.error("Failed to disable device:", error);
  }
  device.release();
}
