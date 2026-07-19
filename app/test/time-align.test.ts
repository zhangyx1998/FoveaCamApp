// Unified time: the min-filter estimator, the latch/pull/ping measurement
// routines against fake hardware, the calibration registry, and sleep
// detection. All pure / injected — no hardware, no real clocks.

import { beforeEach, describe, expect, it } from "vitest";
import {
  calibration,
  clearCalibrations,
  estimateOffsetNs,
  estimateOffsetOneSidedNs,
  hostNsToEpochMs,
  isPullFallbackEnabled,
  latchCameraOffset,
  pingControllerOffset,
  pullCameraOffset,
  setCalibration,
  setPullFallbackEnabled,
  toHostNs,
  bootAnchor,
} from "@orchestrator/time-align";

beforeEach(() => clearCalibrations());

describe("estimateOffsetNs (min-filter)", () => {
  it("picks the smallest-RTT sample's midpoint offset, not the mean", () => {
    // True offset 1000ns; two latency-contaminated samples (late midpoints,
    // wide brackets) that would bias a mean upward.
    const samples = [
      { midNs: 11_000n, rttNs: 400n, subjectNs: 10_000n }, // clean: offset 1000
      { midNs: 13_500n, rttNs: 5_000n, subjectNs: 12_000n }, // late: 1500
      { midNs: 15_800n, rttNs: 9_000n, subjectNs: 14_000n }, // later: 1800
    ];
    const { offsetNs, jitterNs } = estimateOffsetNs(samples);
    expect(offsetNs).toBe(1000n); // min-RTT sample wins
    expect(jitterNs).toBe(800n); // p90 - min = 1800 - 1000
  });

  it("one-sided variant takes the minimum delta (arrival noise is one-sided)", () => {
    const samples = [
      { midNs: 12_000n, rttNs: 0n, subjectNs: 10_000n }, // 2000 (delayed)
      { midNs: 11_100n, rttNs: 0n, subjectNs: 10_000n }, // 1100 (least delayed)
      { midNs: 13_000n, rttNs: 0n, subjectNs: 10_000n }, // 3000 (very delayed)
    ];
    expect(estimateOffsetOneSidedNs(samples).offsetNs).toBe(1100n);
  });

  it("throws on empty input (never a silent zero offset)", () => {
    expect(() => estimateOffsetNs([])).toThrow();
  });
});

describe("latchCameraOffset (primary path)", () => {
  it("brackets each latch with host reads and min-filters by RTT", () => {
    // Fake steady clock ticking 100ns per read; fake camera whose latched
    // value equals hostAtLatch - 5000 (true offset = 5000ns).
    let t = 0n;
    const now = () => (t += 100n);
    let latched = 0n;
    const camera = {
      executeFeature: (name: string) => {
        expect(name).toBe("TimestampLatch");
        latched = t - 5000n; // device clock = host - 5000 at the latch instant
      },
      getFeatureInt: (name: string) => {
        expect(name).toBe("TimestampLatchValue");
        return Number(latched);
      },
    };
    const cal = latchCameraOffset(camera, { n: 5, now });
    expect(cal.method).toBe("latch");
    expect(cal.samples).toBe(5);
    // The latch fires at t0 (no tick in between in this fake), the bracket
    // midpoint is t0+50 — measured offset = true 5000 + 50ns half-bracket.
    expect(cal.offsetNs).toBe(5000n + 50n);
    expect(cal.jitterNs).toBe(0n); // deterministic fake — no spread
  });
});

describe("pullCameraOffset (config-gated fallback)", () => {
  it("min-filters one-sided arrival deltas", () => {
    const frames = [
      { deviceTimestampNs: 1_000n, arrivalHostNs: 9_000n }, // 8000
      { deviceTimestampNs: 2_000n, arrivalHostNs: 9_500n }, // 7500 (min)
      { deviceTimestampNs: 3_000n, arrivalHostNs: 12_000n }, // 9000
    ];
    let i = 0;
    const cal = pullCameraOffset(() => frames[i++]!, { n: 3, now: () => 99n });
    expect(cal.method).toBe("pull");
    expect(cal.offsetNs).toBe(7500n);
  });

  it("fallback gate defaults OFF", () => {
    expect(isPullFallbackEnabled()).toBe(false);
    setPullFallbackEnabled(true);
    expect(isPullFallbackEnabled()).toBe(true);
    setPullFallbackEnabled(false);
  });
});

describe("pingControllerOffset (dedicated timestamp command)", () => {
  it("converts MCU µs to ns and min-filters by RTT", async () => {
    let t = 1_000_000n;
    const now = () => (t += 1000n);
    // MCU clock: hostNs/1000 - 42µs (true offset = 42_000ns), replied at the
    // bracket midpoint.
    const read = async () => (t + 500n) / 1000n - 42n;
    const cal = await pingControllerOffset(read, { n: 4, now });
    expect(cal.method).toBe("ping");
    // subject = (mid/1000 - 42)µs → subjectNs ≈ mid - 42_000 (µs truncation
    // costs < 1µs): offset within [41_000, 43_000].
    expect(cal.offsetNs).toBeGreaterThanOrEqual(41_000n);
    expect(cal.offsetNs).toBeLessThanOrEqual(43_000n);
  });
});

describe("calibration registry", () => {
  it("toHostNs applies the stored offset and THROWS uncalibrated", () => {
    expect(() => toHostNs("camera:SN1", 10n)).toThrow(/not calibrated/);
    setCalibration("camera:SN1", {
      offsetNs: 500n,
      jitterNs: 10n,
      samples: 10,
      method: "latch",
      atNs: 0n,
    });
    expect(toHostNs("camera:SN1", 10n)).toBe(510n);
    expect(calibration("camera:SN1")?.method).toBe("latch");
  });
});

describe("boot anchor labeling", () => {
  it("maps host-ns instants onto wall time relative to the anchor", () => {
    expect(hostNsToEpochMs(bootAnchor.hrtimeNs)).toBe(bootAnchor.epochMs);
    expect(hostNsToEpochMs(bootAnchor.hrtimeNs + 2_000_000_000n)).toBe(
      bootAnchor.epochMs + 2000,
    );
  });
});
