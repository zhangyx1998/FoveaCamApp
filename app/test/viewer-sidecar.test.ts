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
  DEFAULT_PANEL_WIDTH,
  DEFAULT_SPLIT,
  DEFAULT_TILE_WIDTH,
  MAX_PANEL_WIDTH,
  MAX_TILE_WIDTH,
  MIN_PANEL_WIDTH,
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
  threeD: "anaglyph", // GLOBAL mode (ruling 4 amendment)
  split: 0.42,
  tileWidth: 280,
  playheadNs: 123_456,
  panelOpen: true,
  panelWidth: 340,
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

describe("property panel state (UI round 2 ruling 4 — tolerant read)", () => {
  it("absent panel fields default to CLOSED + default width", () => {
    // An older sidecar (no panel keys) must not throw and must read closed.
    const load = classifySidecar(JSON.stringify({ v: 1, tracks: [["a"]] }));
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.state.panelOpen).toBe(false);
    expect(load.state.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });

  it("panelOpen is strictly boolean-true (truthy non-true → closed)", () => {
    const open = classifySidecar(JSON.stringify({ v: 1, panelOpen: true }));
    const weird = classifySidecar(JSON.stringify({ v: 1, panelOpen: "yes" }));
    expect(open.status === "ok" && open.state.panelOpen).toBe(true);
    expect(weird.status === "ok" && weird.state.panelOpen).toBe(false);
  });

  it("panelWidth clamps to [MIN, MAX]; malformed → default", () => {
    const hi = classifySidecar(JSON.stringify({ v: 1, panelWidth: 9_000 }));
    const lo = classifySidecar(JSON.stringify({ v: 1, panelWidth: 10 }));
    const bad = classifySidecar(JSON.stringify({ v: 1, panelWidth: "wide" }));
    expect(hi.status === "ok" && hi.state.panelWidth).toBe(MAX_PANEL_WIDTH);
    expect(lo.status === "ok" && lo.state.panelWidth).toBe(MIN_PANEL_WIDTH);
    expect(bad.status === "ok" && bad.state.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
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
        threeD: "left-only",
        disabled: ["x", "x", 7],
      }),
    );
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.state.tracks).toEqual([["ok"], ["keep"]]);
    expect(load.state.tileWidth).toBe(MAX_TILE_WIDTH);
    expect(load.state.split).toBe(0); // <=0 clamps to the collapsed sentinel
    expect(load.state.playheadNs).toBe(0);
    expect(load.state.threeD).toBe("left-only");
    expect(load.state.disabled).toEqual(["x"]); // deduped, non-strings dropped
  });

  it("MIN_TILE_WIDTH floor holds", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tileWidth: 1 }));
    expect(load.status === "ok" && load.state.tileWidth).toBe(MIN_TILE_WIDTH);
  });
});

describe("threeD global-mode migration (ruling 4 amendment)", () => {
  const mode = (json: object): string => {
    const load = classifySidecar(JSON.stringify({ v: 1, ...json }));
    return load.status === "ok" ? load.state.threeD : "<corrupt>";
  };

  it("new shape: a bare mode string round-trips", () => {
    expect(mode({ threeD: "anaglyph" })).toBe("anaglyph");
    expect(mode({ threeD: "disabled" })).toBe("disabled");
  });

  it("new shape: an unknown mode string falls back to disabled", () => {
    expect(mode({ threeD: "hologram" })).toBe("disabled");
  });

  it("OLD per-pair map collapses to the first non-disabled value", () => {
    expect(mode({ threeD: { camA: "disabled", camB: "anaglyph" } })).toBe("anaglyph");
    expect(mode({ threeD: { left: "right-only" } })).toBe("right-only");
  });

  it("OLD map of all-disabled (or empty / invalid) collapses to disabled", () => {
    expect(mode({ threeD: { a: "disabled", b: "disabled" } })).toBe("disabled");
    expect(mode({ threeD: {} })).toBe("disabled");
    expect(mode({ threeD: { a: "bogus" } })).toBe("disabled");
    expect(mode({})).toBe("disabled"); // absent field
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
