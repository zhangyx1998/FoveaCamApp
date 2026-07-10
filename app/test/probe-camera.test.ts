// Camera-enumeration probe pure helpers (disposable-orchestrator ruling 3):
// list diffing (main forwards to Welcome only on a real change), the status-
// only Welcome status derivation (no more "orchestrator down"), and stable
// sorting. Vue-free / Electron-free — the same helpers the probe process, main,
// and the Welcome renderer share.

import { describe, expect, it } from "vitest";
import {
  cameraListChanged,
  sortedCameras,
  welcomeStatus,
  type ProbeCamera,
} from "../lib/orchestrator/probe";

const cam = (serial: string, extra: Partial<ProbeCamera> = {}): ProbeCamera => ({
  vendor: "FLIR",
  model: "BFS",
  serial,
  ...extra,
});

describe("cameraListChanged", () => {
  it("is false for identical lists (order-independent)", () => {
    const a = [cam("A"), cam("B")];
    const b = [cam("B"), cam("A")]; // enumeration order not stable
    expect(cameraListChanged(a, b)).toBe(false);
  });

  it("detects a added/removed camera", () => {
    expect(cameraListChanged([cam("A")], [cam("A"), cam("B")])).toBe(true);
    expect(cameraListChanged([cam("A"), cam("B")], [cam("A")])).toBe(true);
  });

  it("detects a swapped serial at equal length", () => {
    expect(cameraListChanged([cam("A"), cam("B")], [cam("A"), cam("C")])).toBe(true);
  });

  it("detects a changed displayed field (role / model)", () => {
    expect(cameraListChanged([cam("A")], [cam("A", { role: "L" })])).toBe(true);
    expect(cameraListChanged([cam("A", { model: "X" })], [cam("A", { model: "Y" })])).toBe(true);
  });

  it("ignores a no-op re-enumeration", () => {
    const a = [cam("A", { role: "L" }), cam("B", { role: "R" })];
    const b = [cam("B", { role: "R" }), cam("A", { role: "L" })];
    expect(cameraListChanged(a, b)).toBe(false);
  });
});

describe("welcomeStatus", () => {
  it("shows a probing placeholder before the first snapshot", () => {
    expect(welcomeStatus([], false)).toBe("looking for cameras…");
  });

  it("shows no-cameras and connected states (no 'orchestrator down')", () => {
    expect(welcomeStatus([], true)).toBe("no cameras");
    expect(welcomeStatus([cam("A")], true)).toBe("connected — 1 camera");
    expect(welcomeStatus([cam("A"), cam("B")], true)).toBe("connected — 2 cameras");
  });
});

describe("sortedCameras", () => {
  it("orders L, C, R first then unroled, serial-broken ties", () => {
    const out = sortedCameras([
      cam("z", { role: "R" }),
      cam("m"),
      cam("a", { role: "L" }),
      cam("b", { role: "C" }),
    ]);
    expect(out.map((c) => c.serial)).toEqual(["a", "b", "z", "m"]);
  });

  it("does not mutate the input", () => {
    const input = [cam("b"), cam("a")];
    sortedCameras(input);
    expect(input.map((c) => c.serial)).toEqual(["b", "a"]);
  });
});
