// The write-path: a recorded fovea frame carries the voltage that
// PRODUCED it — the FIN exposure-averaged voltage + `frame_id` for a triggered
// capture, or a live snapshot for a free-run frame. Exercises `buildFoveaMeta`,
// the per-frame metadata builder `consume()` writes into the `.fovea`
// telemetry doc (via B's read-only `frameVoltageExtras`).

import { describe, expect, it } from "vitest";
import {
  buildFoveaMeta,
  resolveFoveaBinding,
  type RecordingDeps,
} from "@modules/manual-control/recording";
import type { Mat } from "core/Vision";
import type { Pos } from "@lib/controller-codec";

// A minimal 3×3 identity homography that `matToArray` can walk (shape/channels
// + indexable), standing in for a real `A2H` Mat.
const H = Object.assign([1, 0, 0, 0, 1, 0, 0, 0, 1], {
  shape: [3, 3],
  channels: 1,
}) as unknown as Mat<Float64Array>;
const A = { x: 0.1, y: 0.2 };

describe("recorded fovea frame metadata", () => {
  it("a triggered (FIN) capture records the exposure-averaged voltage + frame_id", () => {
    const meta = buildFoveaMeta({
      source: "fin",
      frameId: 7,
      volt: { x: 1.25, y: -0.5 },
      A,
      H,
    });
    expect(meta["volt.source"]).toBe("fin-averaged");
    expect(meta.frame_id).toBe(7);
    expect(meta.volt).toEqual({ x: 1.25, y: -0.5 });
    expect(meta["volt.unit"]).toBe("volt");
    // Angle + homography ride along on both paths.
    expect(meta.angle).toEqual({ x: 0.1, y: 0.2 });
    expect(meta["angle.unit"]).toBe("radian");
    expect(Array.isArray(meta.affine)).toBe(true);
  });

  it("a free-run frame records a live snapshot (no frame_id)", () => {
    const meta = buildFoveaMeta({ source: "live", volt: { x: 2, y: 3 }, A, H });
    expect(meta["volt.source"]).toBe("live-snapshot");
    expect(meta.frame_id).toBeUndefined();
    expect(meta.volt).toEqual({ x: 2, y: 3 });
    expect(meta["volt.unit"]).toBe("volt");
    expect(meta.angle).toEqual({ x: 0.1, y: 0.2 });
  });
});

describe("resolveFoveaBinding (fin vs live branch selection)", () => {
  // Identity conversions isolate the branch logic from the (separately-tested)
  // regression math: pixel==angle, angle→a fixed fake homography.
  const conv = {
    V2A: { L: (v: Pos) => v, R: (v: Pos) => v },
    A2H: { L: () => H, R: () => H },
  } as unknown as Parameters<typeof resolveFoveaBinding>[1];

  const baseDeps = (): RecordingDeps => ({
    getTriple: () => null,
    volts: () => ({ L: { x: 9, y: 9 }, R: { x: 8, y: 8 } }),
    telemetry: () => {},
  });

  it("binds the FIN outcome (fin-averaged) when deps.foveaBinding matches a frame", () => {
    const deps: RecordingDeps = {
      ...baseDeps(),
      foveaBinding: (m) => (m === "L" ? { frameId: 42, volt: { x: 1, y: -1 } } : null),
    };
    const b = resolveFoveaBinding(deps, conv, "L");
    expect(b.source).toBe("fin");
    expect(b).toMatchObject({ source: "fin", frameId: 42, volt: { x: 1, y: -1 } });
  });

  it("falls back to the live snapshot when foveaBinding returns null", () => {
    const deps: RecordingDeps = { ...baseDeps(), foveaBinding: () => null };
    const b = resolveFoveaBinding(deps, conv, "R");
    expect(b.source).toBe("live");
    expect(b).toMatchObject({ source: "live", volt: { x: 8, y: 8 } }); // deps.volts().R
  });

  it("falls back to the live snapshot when deps has no foveaBinding hook at all", () => {
    const b = resolveFoveaBinding(baseDeps(), conv, "L");
    expect(b.source).toBe("live");
    expect(b).toMatchObject({ source: "live", volt: { x: 9, y: 9 } }); // deps.volts().L
  });
});
