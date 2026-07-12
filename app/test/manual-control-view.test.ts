// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Manual-control center-view coercion (app/modules/manual-control/contract.ts).
// The legacy display-kernel modes (diff/depth) are retired in favor of native
// pipes; `coerceView` maps any persisted/untyped value onto the current union
// so a stale value never selects a dead kernel path. Behavior spec:
// docs/spec/manual-control.md §views.

import { describe, expect, it } from "vitest";
import { coerceView } from "@modules/manual-control/contract";

describe("manual-control coerceView", () => {
  it("passes the current union values through unchanged", () => {
    for (const v of ["sliced", "disparity", "anaglyph", "sgbm"] as const)
      expect(coerceView(v)).toBe(v);
  });

  it("maps legacy diff → disparity (the composite difference view)", () => {
    expect(coerceView("diff")).toBe("disparity");
  });

  it("maps legacy depth → sgbm (the stereo heatmap view)", () => {
    expect(coerceView("depth")).toBe("sgbm");
  });

  it("falls back to sliced for anything unrecognized", () => {
    for (const v of ["", "bogus", undefined, null, 3, {}])
      expect(coerceView(v)).toBe("sliced");
  });
});
