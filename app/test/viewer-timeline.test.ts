// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure timeline model (viewer-timeline.md): auto-pack, master detection, 3D
// pairing (incl. must-not-pair), Z-order → tile order, enabled/decode set,
// drag-move + collision, and stored-layout reconciliation. No Vue/Node/core.

import { describe, expect, it } from "vitest";
import {
  activeChannels,
  autoPack,
  composeTiles,
  decodeSet,
  detectMaster,
  detectPairs,
  dropCollides,
  initialLayout,
  layoutMismatch,
  moveBlock,
  reconcileLayout,
  sideOf,
  type ChannelBlock,
  type ChannelPair,
  type ThreeDMode,
} from "@src/viewer/timeline";

const b = (channel: string, startNs: number, lastNs: number): ChannelBlock => ({
  channel,
  startNs,
  lastNs,
});

// ---- auto-pack ------------------------------------------------------------

describe("autoPack", () => {
  it("uses the minimum number of tracks (== max overlap)", () => {
    // Three mutually-overlapping blocks → 3 rows; a 4th disjoint → row reuse.
    const rows = autoPack([
      b("a", 0, 100),
      b("b", 10, 110),
      b("c", 20, 120),
      b("d", 200, 300), // disjoint from all → reuses the first freed row
    ]);
    expect(rows.length).toBe(3);
    // "d" packs onto the earliest row whose block ended before 200 → row of "a".
    expect(rows[0]).toEqual(["a", "d"]);
    expect(rows[1]).toEqual(["b"]);
    expect(rows[2]).toEqual(["c"]);
  });

  it("packs non-overlapping blocks onto a single track", () => {
    const rows = autoPack([b("a", 0, 100), b("b", 100, 200), b("c", 200, 300)]);
    expect(rows).toEqual([["a", "b", "c"]]);
  });

  it("is deterministic under input reordering", () => {
    const blocks = [b("z", 0, 50), b("y", 60, 100), b("x", 0, 50)];
    const r1 = autoPack(blocks);
    const r2 = autoPack([...blocks].reverse());
    expect(r1).toEqual(r2);
    // Overlapping x,z sort by name; y reuses the first row.
    expect(r1).toEqual([["x", "y"], ["z"]]);
  });

  it("treats touching-at-a-point blocks as non-overlapping", () => {
    expect(autoPack([b("a", 0, 100), b("b", 100, 200)])).toEqual([["a", "b"]]);
  });
});

// ---- master detection -----------------------------------------------------

describe("detectMaster", () => {
  it("picks the 'center' designation (manual-control wide)", () => {
    expect(detectMaster(["left", "center", "right"])).toEqual({
      channel: "center",
      designated: true,
    });
  });
  it("picks a 'wide' designation (multi-fovea)", () => {
    expect(detectMaster(["camA", "wide"])).toEqual({ channel: "wide", designated: true });
  });
  it("falls back to the first frame channel, flagged undesignated", () => {
    expect(detectMaster(["camA", "camB"])).toEqual({ channel: "camA", designated: false });
  });
  it("returns null channel for no frame channels", () => {
    expect(detectMaster([])).toEqual({ channel: null, designated: false });
  });
});

// ---- 3D pairing -----------------------------------------------------------

describe("sideOf / detectPairs", () => {
  it("extracts side + shared base across separator and case styles", () => {
    expect(sideOf("left-cam")).toEqual({ side: "left", base: "cam" });
    expect(sideOf("right_cam")).toEqual({ side: "right", base: "cam" });
    expect(sideOf("camL")).toEqual({ side: "left", base: "cam" });
    expect(sideOf("cam/R")).toEqual({ side: "right", base: "cam" });
  });

  it("does NOT treat a side-less or base-less name as a side", () => {
    expect(sideOf("center")).toBeNull(); // no side token
    expect(sideOf("wide")).toBeNull();
    expect(sideOf("l")).toBeNull(); // side token but EMPTY base → not a side
    expect(sideOf("leftover")).toBeNull(); // "left" is not a whole segment here
  });

  it("pairs matching L/R bases", () => {
    expect(detectPairs(["left-cam", "right-cam", "center"])).toEqual([
      { base: "cam", left: "left-cam", right: "right-cam" },
    ]);
  });

  it("MUST NOT false-pair unrelated streams", () => {
    // Different bases, and a lone 'center' — no pair.
    expect(detectPairs(["left-eye", "right-cam", "center"])).toEqual([]);
  });

  it("MUST NOT pair an ambiguous base (two lefts)", () => {
    expect(detectPairs(["cam-left", "camL", "cam-right"])).toEqual([]);
  });
});

// ---- initial layout -------------------------------------------------------

describe("initialLayout", () => {
  it("puts the master on row 0 and auto-packs the rest below", () => {
    const rows = initialLayout(
      [b("center", 0, 300), b("left", 0, 100), b("right", 0, 100)],
      "center",
    );
    expect(rows[0]).toEqual(["center"]);
    // left & right overlap → two rows below.
    expect(rows.slice(1)).toEqual([["left"], ["right"]]);
  });
  it("auto-packs with no master designation", () => {
    const rows = initialLayout([b("a", 0, 100), b("b", 100, 200)], "a");
    expect(rows).toEqual([["a"], ["b"]]);
  });
});

// ---- tiles / Z order ------------------------------------------------------

function pairModes(
  pairs: ChannelPair[],
  modes: Record<string, ThreeDMode>,
): Map<string, { pair: ChannelPair; mode: ThreeDMode }> {
  const m = new Map<string, { pair: ChannelPair; mode: ThreeDMode }>();
  for (const p of pairs) {
    const mode = modes[p.base] ?? "disabled";
    m.set(p.left, { pair: p, mode });
    m.set(p.right, { pair: p, mode });
  }
  return m;
}

describe("composeTiles (Z order → tile order)", () => {
  const pairs = detectPairs(["left-cam", "right-cam"]);

  it("keeps master-first, top→bottom order for singles", () => {
    const tiles = composeTiles(["center", "aux"], new Map());
    expect(tiles.map((t) => (t.kind === "single" ? t.channel : ""))).toEqual([
      "center",
      "aux",
    ]);
  });

  it("disabled 3D mode → two independent tiles", () => {
    const tiles = composeTiles(["left-cam", "right-cam"], pairModes(pairs, {}));
    expect(tiles.map((t) => t.kind)).toEqual(["single", "single"]);
  });

  it("anaglyph collapses the pair to ONE tile at the higher (earlier) position", () => {
    const tiles = composeTiles(
      ["center", "left-cam", "right-cam"],
      pairModes(pairs, { cam: "anaglyph" }),
    );
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toMatchObject({ kind: "single", channel: "center" });
    expect(tiles[1]).toMatchObject({ kind: "pair", mode: "anaglyph" });
    expect((tiles[1] as { channels: string[] }).channels).toEqual(["left-cam", "right-cam"]);
  });

  it("left-only renders one tile decoding only the left side", () => {
    const tiles = composeTiles(
      ["left-cam", "right-cam"],
      pairModes(pairs, { cam: "left-only" }),
    );
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ kind: "pair", mode: "left-only" });
    expect((tiles[0] as { channels: string[] }).channels).toEqual(["left-cam"]);
  });
});

// ---- enabled / decode set -------------------------------------------------

describe("decodeSet (enabled-set worker protocol shape)", () => {
  const pairs = detectPairs(["left-cam", "right-cam"]);

  it("is sorted + de-duplicated", () => {
    expect(decodeSet(["b", "a", "b"], new Map())).toEqual(["a", "b"]);
  });

  it("skips the hidden side under left-/right-only", () => {
    const modes = pairModes(pairs, { cam: "left-only" });
    expect(decodeSet(["left-cam", "right-cam"], modes)).toEqual(["left-cam"]);
    const modesR = pairModes(pairs, { cam: "right-only" });
    expect(decodeSet(["left-cam", "right-cam"], modesR)).toEqual(["right-cam"]);
  });

  it("keeps both sides for anaglyph and disabled", () => {
    const modes = pairModes(pairs, { cam: "anaglyph" });
    expect(decodeSet(["left-cam", "right-cam"], modes)).toEqual(["left-cam", "right-cam"]);
  });

  // Ruling 4 amendment (user 2026-07-09): 3D mode is GLOBAL — one mode applies
  // to EVERY pair. The pairModeOf map the UI feeds decodeSet is built by
  // stamping the single mode onto all pairs; the hidden-side skip then derives
  // from that one mode uniformly.
  it("global mode: one mode drops the hidden side of every pair at once", () => {
    const many = detectPairs(["left-cam", "right-cam", "left-eye", "right-eye"]);
    const global = (mode: ThreeDMode) => {
      const m = new Map<string, { pair: ChannelPair; mode: ThreeDMode }>();
      for (const p of many) {
        m.set(p.left, { pair: p, mode });
        m.set(p.right, { pair: p, mode });
      }
      return m;
    };
    const chans = ["left-cam", "right-cam", "left-eye", "right-eye"];
    expect(decodeSet(chans, global("left-only"))).toEqual(["left-cam", "left-eye"]);
    expect(decodeSet(chans, global("right-only"))).toEqual(["right-cam", "right-eye"]);
    expect(decodeSet(chans, global("anaglyph"))).toEqual(chans.slice().sort());
  });
});

// ---- active channels ------------------------------------------------------

describe("activeChannels", () => {
  const blocks = [b("center", 0, 300), b("left", 0, 100), b("aux", 200, 300)];
  const rows = [["center"], ["left", "aux"]];

  it("returns Z-ordered channels whose block spans the playhead and are enabled", () => {
    const enabled = new Set(["center", "left", "aux"]);
    expect(activeChannels(rows, blocks, 50, enabled)).toEqual(["center", "left"]);
    expect(activeChannels(rows, blocks, 250, enabled)).toEqual(["center", "aux"]);
  });
  it("excludes disabled channels", () => {
    expect(activeChannels(rows, blocks, 50, new Set(["center"]))).toEqual(["center"]);
  });
});

// ---- drag move + collision ------------------------------------------------

describe("moveBlock / dropCollides", () => {
  const blocks = [b("center", 0, 300), b("left", 0, 100), b("right", 0, 100)];

  it("detects a colliding drop (overlap on the target row)", () => {
    const rows = [["center"], ["left"], ["right"]];
    // left overlaps right (both 0..100) → dropping left onto right's row collides.
    expect(dropCollides(rows, blocks, "left", 2)).toBe(true);
    // dropping onto a brand-new bottom row never collides.
    expect(dropCollides(rows, blocks, "left", 3)).toBe(false);
  });

  it("moves a block to another row and drops now-empty rows", () => {
    const rows = [["center"], ["left"], ["right"]];
    // Move "right" up to a NEW row 0? Move "left" onto a fresh bottom row (3):
    const next = moveBlock(rows, blocks, "left", 3);
    // left's old row 1 becomes empty and is removed → [center],[right],[left].
    expect(next).toEqual([["center"], ["right"], ["left"]]);
  });

  it("keeps blocks on a shared row sorted by start", () => {
    const packed = [b("a", 100, 200), b("c", 0, 50)];
    const rows = [["a"], ["c"]];
    const next = moveBlock(rows, packed, "c", 0); // c(0..50) onto a's row (a=100..200)
    expect(next).toEqual([["c", "a"]]);
  });
});

// ---- stored-layout reconciliation (ruling 10) -----------------------------

describe("reconcileLayout / layoutMismatch", () => {
  it("flags a mismatch when channels differ from the container", () => {
    expect(layoutMismatch([["center"], ["gone"]], ["center", "added"])).toBe(true);
    expect(layoutMismatch([["center"], ["a"]], ["a", "center"])).toBe(false);
  });

  it("drops absent channels and appends present-but-missing ones", () => {
    const next = reconcileLayout([["center"], ["gone"]], ["center", "added"]);
    expect(next).toEqual([["center"], ["added"]]);
  });
});
