// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Serial-latency compensation math (serial-rate-governor.md Part 4): the pure
// EMA(ackRttMs.p50)/2 estimator the disparity-scope session feeds into
// `imm.setParams`, the applied-lookahead bus bridging it into the controller
// session's serial-pressure telemetry, and the config coercion.

import { describe, expect, it } from "vitest";
import {
  currentAppliedLookahead,
  publishAppliedLookahead,
  SerialLatencyEstimator,
  SERIAL_LATENCY_EMA_ALPHA,
} from "@orchestrator/serial-latency";

describe("SerialLatencyEstimator", () => {
  it("is null before the first sample (no samples = fixed behavior)", () => {
    const e = new SerialLatencyEstimator();
    expect(e.latencyMs).toBeNull();
  });

  it("first sample seeds the EMA; latency = RTT/2 (one-way)", () => {
    const e = new SerialLatencyEstimator();
    e.push(4);
    expect(e.latencyMs).toBeCloseTo(2, 9);
  });

  it("EMA smooths a step — RTT jitter never whips the predictor", () => {
    const e = new SerialLatencyEstimator();
    e.push(2); // ema = 2
    e.push(10); // ema = 2 + α(10−2)
    const expected = (2 + SERIAL_LATENCY_EMA_ALPHA * 8) / 2;
    expect(e.latencyMs).toBeCloseTo(expected, 9);
    // Converges toward the step over repeated samples.
    for (let i = 0; i < 50; i++) e.push(10);
    expect(e.latencyMs).toBeCloseTo(5, 2);
  });

  it("ignores non-finite / negative samples (probe hiccup safety)", () => {
    const e = new SerialLatencyEstimator();
    e.push(6);
    e.push(NaN);
    e.push(-1);
    e.push(Infinity);
    expect(e.latencyMs).toBeCloseTo(3, 9);
  });

  it("reset returns to the no-sample (fixed) state", () => {
    const e = new SerialLatencyEstimator();
    e.push(6);
    e.reset();
    expect(e.latencyMs).toBeNull();
  });
});

describe("applied-lookahead bus", () => {
  it("bridges the disparity session's applied value to the controller probe", () => {
    publishAppliedLookahead(14.5);
    expect(currentAppliedLookahead()).toBe(14.5);
    publishAppliedLookahead(null); // predictor session gone
    expect(currentAppliedLookahead()).toBeNull();
  });
});
