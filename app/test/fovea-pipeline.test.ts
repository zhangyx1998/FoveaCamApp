import { describe, expect, it } from "vitest";
import {
  clampRectToSize,
  depthFromInverse,
  radians,
} from "@orchestrator/fovea-pipeline";

describe("fovea pipeline primitives", () => {
  it("clamps rectangles into the current frame size", () => {
    expect(
      clampRectToSize(
        { x: -5.4, y: 8.6, width: 50.2, height: 20.2 },
        { width: 30, height: 20 },
      ),
    ).toEqual({ x: 0, y: 9, width: 30, height: 11 });
  });

  it("converts inverse-depth slider state to a finite or infinite window", () => {
    expect(depthFromInverse(0)).toBe(Infinity);
    expect(depthFromInverse(-1)).toBe(Infinity);
    expect(depthFromInverse(0.5)).toBe(4);
  });

  it("converts degrees to radians", () => {
    expect(radians(180)).toBeCloseTo(Math.PI);
  });
});
