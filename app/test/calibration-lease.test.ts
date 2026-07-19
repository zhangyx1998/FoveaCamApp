// orchestrator/calibration.ts:
//   - leaseCalibratedTriple must RELEASE all three camera leases when
//       anything after the acquire throws (a fresh/uncalibrated rig ALWAYS
//       throws in loadConversions) — the leak wedged every camera-owning
//       module until force-release/restart.
//   - fitExtrinsicRegression refuses an underdetermined cubic fit (< 10
//       poses) with a NAMED, actionable error instead of letting the SVD
//       return silently-plausible minimum-norm garbage.
// Native seams + store/registry mocked (established marker-calibration
// pattern); the module under test runs for real.

import { describe, expect, it, vi } from "vitest";

const ctl = vi.hoisted(() => ({
  disk: new Map<string, unknown>(),
  triple: undefined as unknown as () => Promise<unknown>,
  pinhole: undefined as unknown as () => Promise<Record<string, unknown>>,
}));

vi.mock("core/Vision", () => ({
  Undistort: class {
    fov = { x: 1, y: 1 };
  },
}));

vi.mock("core/Regression", () => ({
  default: class {
    fit(_v: unknown, _a: unknown) {
      return { predict: (p: unknown) => p };
    }
  },
}));

vi.mock("@lib/marker", () => ({
  findPinholeProjection: () => ctl.pinhole(),
}));

vi.mock("@orchestrator/store-hub", () => {
  const key = (segs: string | string[]) => (Array.isArray(segs) ? segs : [segs]).join("/");
  return {
    read: async (segs: string | string[], fallback: unknown) =>
      ctl.disk.has(key(segs)) ? ctl.disk.get(key(segs)) : fallback,
    list: async (dir: string) =>
      [...ctl.disk.keys()]
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1)),
  };
});

vi.mock("@orchestrator/registry", () => ({
  matchTriple: () => ctl.triple(),
  retryUntil: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@orchestrator/camera", () => ({
  cameraConfigPath: (info: { serial: string }) => ["camera-config", info.serial],
  listCameraInfo: async () => [],
}));

import {
  ExtrinsicFitError,
  fitExtrinsicRegression,
  leaseCalibratedTriple,
  MIN_EXTRINSIC_SAMPLES,
} from "@orchestrator/calibration";
import type { ExtrinsicDataset } from "@lib/camera-config";

// --- fixtures ------------------------------------------------------------------

function fakeLease(serial: string) {
  return {
    camera: { serial, vendor: "V", model: "M" },
    release: vi.fn(),
  };
}

function fakeTriple() {
  return { L: fakeLease("L1"), C: fakeLease("C1"), R: fakeLease("R1") };
}

const pose = (i: number) => ({
  angle: { x: i, y: i },
  voltage: { x: i / 10, y: i / 10 },
});

const dataset = (n: number): ExtrinsicDataset =>
  Array.from({ length: n }, (_, i) => pose(i)) as ExtrinsicDataset;

const PINHOLE_OK = {
  A2H: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scale: 1,
  scale_std: 0,
  magnification: 2,
  magnification_std: 0,
};

// --- tests -----------------------------------------------------------------------

describe("fitExtrinsicRegression minimum-sample gate (#14)", () => {
  it("throws the NAMED error with an actionable message below the threshold", async () => {
    const err = await fitExtrinsicRegression(dataset(5)).catch((e) => e);
    expect(err).toBeInstanceOf(ExtrinsicFitError);
    expect((err as Error).name).toBe("ExtrinsicFitError");
    expect((err as Error).message).toBe(
      "extrinsic dataset has 5 poses; >= 10 required for the cubic fit",
    );
  });

  it("keeps the empty-dataset message distinct (existing contract)", async () => {
    await expect(fitExtrinsicRegression([] as ExtrinsicDataset)).rejects.toThrow(
      /No extrinsic data/,
    );
  });

  it("fits normally at/above the threshold", async () => {
    ctl.pinhole = async () => PINHOLE_OK;
    const fit = await fitExtrinsicRegression(dataset(MIN_EXTRINSIC_SAMPLES));
    expect(fit.magnification).toBe(2);
    expect(typeof fit.V2A.predict).toBe("function");
  });
});

describe("leaseCalibratedTriple release-on-throw (#2)", () => {
  it("releases ALL three leases when loadConversions throws (uncalibrated rig)", async () => {
    ctl.disk.clear();
    const triple = fakeTriple();
    ctl.triple = async () => triple;
    // Empty store → no extrinsic dataset → fitExtrinsicRegression throws — the
    // exact path a fresh rig hits on every activation.
    const err = await leaseCalibratedTriple().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(triple.L.release).toHaveBeenCalledTimes(1);
    expect(triple.C.release).toHaveBeenCalledTimes(1);
    expect(triple.R.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the error surface — the original throw propagates to the caller", async () => {
    ctl.disk.clear();
    ctl.triple = async () => fakeTriple();
    await expect(leaseCalibratedTriple()).rejects.toThrow(/extrinsic data/i);
  });

  it("does not release on the success path (leases stay with the caller)", async () => {
    ctl.disk.clear();
    // Seed BOTH eyes' legacy extrinsic datasets (>= threshold) so the load
    // succeeds without records.
    const key = (cam: string) => `calibrate-extrinsic/V_M_${cam}`;
    ctl.disk.set(key("L1"), dataset(MIN_EXTRINSIC_SAMPLES));
    ctl.disk.set(key("R1"), dataset(MIN_EXTRINSIC_SAMPLES));
    ctl.pinhole = async () => PINHOLE_OK;
    const triple = fakeTriple();
    ctl.triple = async () => triple;
    const result = await leaseCalibratedTriple();
    expect(result).not.toBeNull();
    expect(triple.L.release).not.toHaveBeenCalled();
    expect(triple.C.release).not.toHaveBeenCalled();
    expect(triple.R.release).not.toHaveBeenCalled();
  });

  it("null (no triple leased) stays null — no throw, nothing to release", async () => {
    ctl.triple = async () => null;
    expect(await leaseCalibratedTriple()).toBeNull();
  });
});
