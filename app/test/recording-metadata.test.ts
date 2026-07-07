// WS4 4b write-path (A-22): a recorded fovea frame carries the voltage that
// PRODUCED it — the FIN exposure-averaged voltage + `frame_id` for a triggered
// capture, or a live snapshot for a free-run frame. Exercises `buildFoveaMeta`,
// the per-frame metadata builder `consume()` writes into the `.fovea`
// telemetry doc (via B's read-only `frameVoltageExtras`).

import { describe, expect, it } from "vitest";
import { buildFoveaMeta } from "@modules/manual-control/recording";
import type { Mat } from "core/Vision";

// A minimal 3×3 identity homography that `matToArray` can walk (shape/channels
// + indexable), standing in for a real `A2H` Mat.
const H = Object.assign([1, 0, 0, 0, 1, 0, 0, 0, 1], {
  shape: [3, 3],
  channels: 1,
}) as unknown as Mat<Float64Array>;
const A = { x: 0.1, y: 0.2 };

describe("recorded fovea frame metadata (WS4 4b)", () => {
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
