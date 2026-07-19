// Coverage for the shared camera-control schema (A-P11): the declarative
// `CAMERA_CONTROLS` source and `readControlFields`, which the manage-cameras
// snapshot, reset, contract type, and UI all derive from. Pure — no `core`.

import { describe, expect, it } from "vitest";
import {
  CAMERA_CONTROLS,
  readControlFields,
} from "@lib/camera-config";

// The control-family fields `CameraControlsView` (and thus the wire `CameraView`)
// promises. `readControlFields` + the schema must produce exactly these — the
// drift guard the schema exists for.
const CONTROL_FIELDS = [
  "frame_rate_available", "frame_rate_enable", "frame_rate", "frame_rate_range",
  "exposure_auto_available", "exposure_auto", "exposure", "exposure_range",
  "gain_auto_available", "gain_auto", "gain", "gain_range",
  "black_level_available", "black_level_auto_available", "black_level_auto",
  "black_level", "black_level_range",
].sort();

const identitySafe = <T>(get: () => T, fallback: T): T => {
  try {
    return get();
  } catch {
    return fallback;
  }
};

/** A camera stand-in exposing every control getter the schema names. */
function fakeCamera(): Record<string, any> {
  return {
    frame_rate_available: true,
    frame_rate_enable: true,
    frame_rate: 30,
    frame_rate_range: { min: 1, max: 60 },
    exposure_auto_available: true,
    exposure_auto: "Off",
    exposure: 8000,
    exposure_range: { min: 10, max: 100000 },
    gain_auto_available: true,
    gain_auto: "Continuous",
    gain: 3.5,
    gain_range: { min: 0, max: 24 },
    black_level_available: true,
    black_level_auto_available: false,
    black_level_auto: "Off",
    black_level: 1.25,
    black_level_range: { min: 0, max: 10 },
  };
}

describe("camera control schema", () => {
  it("names only valid, non-overlapping field keys per control", () => {
    for (const ctrl of CAMERA_CONTROLS) {
      expect(ctrl.key).toBeTruthy();
      expect(ctrl.availableKey).toContain(ctrl.key);
      expect(ctrl.rangeKey).toBe(`${ctrl.key}_range`);
      if (ctrl.autoKey) expect(ctrl.autoKey).toBe(`${ctrl.key}_auto`);
      if (ctrl.enableKey) expect(ctrl.enableKey).toBe(`${ctrl.key}_enable`);
      // frame rate has an enable toggle and no auto mode; the rest are inverse.
      expect(!!ctrl.enableKey).toBe(!ctrl.autoKey);
    }
  });

  it("readControlFields covers exactly the control-family fields", () => {
    const snap = readControlFields(fakeCamera(), identitySafe);
    expect(Object.keys(snap).sort()).toEqual(CONTROL_FIELDS);
  });

  it("readControlFields reads live values through the guard", () => {
    const snap = readControlFields(fakeCamera(), identitySafe) as Record<string, any>;
    expect(snap.frame_rate).toBe(30);
    expect(snap.frame_rate_range).toEqual({ min: 1, max: 60 });
    expect(snap.gain_auto).toBe("Continuous");
    expect(snap.black_level).toBe(1.25);
    expect(snap.exposure_auto_available).toBe(true);
  });

  it("falls back per field when a getter throws (safe() preserved)", () => {
    // A camera released mid-poll: every getter throws. Must not propagate.
    const thrower = new Proxy(
      {},
      {
        get() {
          throw new Error("released");
        },
      },
    ) as Record<string, any>;
    const snap = readControlFields(thrower, identitySafe) as Record<string, any>;
    expect(Object.keys(snap).sort()).toEqual(CONTROL_FIELDS);
    expect(snap.frame_rate).toBe(0);
    expect(snap.frame_rate_range).toEqual({ min: 0, max: 0 });
    expect(snap.exposure_auto).toBe("Off");
    expect(snap.black_level_available).toBe(false);
  });

  it("formatters render the readout units", () => {
    const by = Object.fromEntries(CAMERA_CONTROLS.map((c) => [c.key, c]));
    expect(by.frame_rate.format(29.997)).toBe("30.00 FPS");
    expect(by.exposure.format(8000)).toBe("8.00 ms");
    expect(by.gain.format(3.5)).toBe("3.50 dB");
    expect(by.black_level.format(1.25)).toBe("1.25 dB");
  });
});
