// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer UI-state sidecar (viewer-timeline.md ruling 8/10): round-trip, the
// absent/ok/corrupt classification, field clamping, and the path derivation.

import { describe, expect, it } from "vitest";
import {
  classifySidecar,
  DEFAULT_SPLIT,
  DEFAULT_TILE_WIDTH,
  MAX_TILE_WIDTH,
  MIN_TILE_WIDTH,
  defaultSidecar,
  parseSidecar,
  serializeSidecar,
  sidecarPathFor,
  type SidecarState,
} from "@src/viewer/sidecar";

const sample: SidecarState = {
  v: 1,
  tracks: [["center"], ["left", "aux"], ["right"]],
  disabled: ["aux"],
  threeD: { cam: "anaglyph" },
  split: 0.42,
  tileWidth: 280,
  playheadNs: 123_456,
};

describe("sidecar round-trip", () => {
  it("serialize → classify preserves the state exactly", () => {
    const load = classifySidecar(serializeSidecar(sample));
    expect(load.status).toBe("ok");
    expect(load.status === "ok" && load.state).toEqual(sample);
  });
});

describe("classifySidecar", () => {
  it("null / undefined → absent (silent initialize)", () => {
    expect(classifySidecar(null)).toEqual({ status: "absent" });
    expect(classifySidecar(undefined)).toEqual({ status: "absent" });
  });

  it("unparseable / empty / non-object → corrupt", () => {
    expect(classifySidecar("{not json").status).toBe("corrupt");
    expect(classifySidecar("").status).toBe("corrupt");
    expect(classifySidecar("[]").status).toBe("corrupt");
    expect(classifySidecar("42").status).toBe("corrupt");
  });

  it("version skew → corrupt (never silently reset)", () => {
    expect(classifySidecar(JSON.stringify({ v: 99, tracks: [] })).status).toBe("corrupt");
  });

  it("valid but partial → ok, missing fields defaulted", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tracks: [["a"]] }));
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.state.tracks).toEqual([["a"]]);
    expect(load.state.split).toBe(DEFAULT_SPLIT);
    expect(load.state.tileWidth).toBe(DEFAULT_TILE_WIDTH);
    expect(load.state.disabled).toEqual([]);
  });
});

describe("field coercion / clamping", () => {
  it("clamps tileWidth and drops malformed rows / non-string channels", () => {
    const load = classifySidecar(
      JSON.stringify({
        v: 1,
        tracks: [["ok"], "nope", [1, "keep", null]],
        tileWidth: 5_000,
        split: -3,
        playheadNs: -10,
        threeD: { cam: "bogus", eye: "left-only" },
        disabled: ["x", "x", 7],
      }),
    );
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.state.tracks).toEqual([["ok"], ["keep"]]);
    expect(load.state.tileWidth).toBe(MAX_TILE_WIDTH);
    expect(load.state.split).toBe(0); // <=0 clamps to the collapsed sentinel
    expect(load.state.playheadNs).toBe(0);
    expect(load.state.threeD).toEqual({ eye: "left-only" }); // bogus mode dropped
    expect(load.state.disabled).toEqual(["x"]); // deduped, non-strings dropped
  });

  it("MIN_TILE_WIDTH floor holds", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tileWidth: 1 }));
    expect(load.status === "ok" && load.state.tileWidth).toBe(MIN_TILE_WIDTH);
  });
});

describe("parseSidecar (best-effort) + path", () => {
  it("absent/corrupt → defaults", () => {
    expect(parseSidecar(null)).toEqual(defaultSidecar());
    expect(parseSidecar("{bad")).toEqual(defaultSidecar());
  });
  it("derives <path>.ui.json next to the container", () => {
    expect(sidecarPathFor("/data/rec/recording.fcap")).toBe(
      "/data/rec/recording.fcap.ui.json",
    );
  });
});
