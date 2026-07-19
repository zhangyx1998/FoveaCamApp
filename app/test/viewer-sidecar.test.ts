// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer UI-state sidecar: round-trip, the
// absent/ok/corrupt classification, field clamping, and the path derivation.

import { describe, expect, it } from "vitest";
import {
  classifySidecar,
  DEFAULT_PANEL_WIDTH,
  DEFAULT_SPLIT,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
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
  threeD: "anaglyph", // GLOBAL mode
  split: 0.42,
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
    expect(load.state.disabled).toEqual([]);
  });
});

describe("property panel state (tolerant read)", () => {
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
  it("drops malformed rows / non-string channels and clamps scalars", () => {
    const load = classifySidecar(
      JSON.stringify({
        v: 1,
        tracks: [["ok"], "nope", [1, "keep", null]],
        split: -3,
        playheadNs: -10,
        threeD: "left-only",
        disabled: ["x", "x", 7],
      }),
    );
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect(load.state.tracks).toEqual([["ok"], ["keep"]]);
    expect(load.state.split).toBe(0); // <=0 clamps to the collapsed sentinel
    expect(load.state.playheadNs).toBe(0);
    expect(load.state.threeD).toBe("left-only");
    expect(load.state.disabled).toEqual(["x"]); // deduped, non-strings dropped
  });
});

describe("threeD global-mode migration", () => {
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

describe("tile order (optional, conservative parse)", () => {
  it("absent tileOrder stays absent (older sidecar round-trips unchanged)", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tracks: [["a"]] }));
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect("tileOrder" in load.state).toBe(false);
  });

  it("a present tileOrder round-trips and is cleaned (non-int / negative / dupes dropped)", () => {
    const load = classifySidecar(
      JSON.stringify({ v: 1, tracks: [["a"], ["b"], ["c"]], tileOrder: [2, 0, 1] }),
    );
    expect(load.status === "ok" && load.state.tileOrder).toEqual([2, 0, 1]);
    const dirty = classifySidecar(
      JSON.stringify({ v: 1, tileOrder: [1, 1, -3, 2.5, "x", 0] }),
    );
    expect(dirty.status === "ok" && dirty.state.tileOrder).toEqual([1, 0]);
  });

  it("a non-array tileOrder drops to absent (never corrupts the whole state)", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tileOrder: "nope" }));
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect("tileOrder" in load.state).toBe(false);
  });

  it("serialize → classify preserves a tileOrder exactly", () => {
    const withOrder: SidecarState = { ...sample, tileOrder: [1, 2, 0] };
    const load = classifySidecar(serializeSidecar(withOrder));
    expect(load.status === "ok" && load.state).toEqual(withOrder);
  });
});

describe("tile sizes (optional, conservative parse; no sum normalization)", () => {
  it("absent tileSizes stays absent (older sidecar round-trips unchanged)", () => {
    const load = classifySidecar(JSON.stringify({ v: 1, tracks: [["a"]] }));
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    expect("tileSizes" in load.state).toBe(false);
  });

  it("a present tileSizes round-trips, keeping finite entries WITHOUT renormalizing", () => {
    const load = classifySidecar(
      JSON.stringify({ v: 1, tracks: [["a"], ["b"]], tileSizes: [0.3, 0.7] }),
    );
    expect(load.status === "ok" && load.state.tileSizes).toEqual([0.3, 0.7]);
    // Parser must NOT force sum-to-1: an off-sum list survives verbatim.
    const off = classifySidecar(JSON.stringify({ v: 1, tileSizes: [0.2, 0.2, 0.2] }));
    expect(off.status === "ok" && off.state.tileSizes).toEqual([0.2, 0.2, 0.2]);
  });

  it("drops non-finite entries; a non-array drops to absent", () => {
    const dirty = classifySidecar(
      JSON.stringify({ v: 1, tileSizes: [0.5, "x", null, 0.5] }),
    );
    // NaN/Infinity can't survive JSON, so exercise the finite filter via strings/null.
    expect(dirty.status === "ok" && dirty.state.tileSizes).toEqual([0.5, 0.5]);
    const notArr = classifySidecar(JSON.stringify({ v: 1, tileSizes: "nope" }));
    expect(notArr.status).toBe("ok");
    if (notArr.status !== "ok") return;
    expect("tileSizes" in notArr.state).toBe(false);
  });

  it("serialize → classify preserves a tileSizes exactly", () => {
    const withSizes: SidecarState = { ...sample, tileSizes: [0.25, 0.25, 0.5] };
    const load = classifySidecar(serializeSidecar(withSizes));
    expect(load.status === "ok" && load.state).toEqual(withSizes);
  });
});

describe("retired tileWidth (write dropped, read tolerated)", () => {
  it("serialized sidecar no longer carries a tileWidth key", () => {
    expect(serializeSidecar(sample)).not.toContain("tileWidth");
  });

  it("an old sidecar's tileWidth is tolerated (ignored, never corrupts the parse)", () => {
    const load = classifySidecar(
      JSON.stringify({ v: 1, tracks: [["a"]], tileWidth: 320 }),
    );
    expect(load.status).toBe("ok");
    if (load.status !== "ok") return;
    // The unknown/retired field must not surface on the parsed state.
    expect("tileWidth" in load.state).toBe(false);
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
