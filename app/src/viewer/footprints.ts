// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE fovea-footprint model (Vue/Node/core-free, unit-tested): a fovea stream's
// frame rectangle projected onto the wide tile via its per-frame `affine`, plus
// pair color-grouping and vergence-plane depth.
// spec: docs/spec/viewer.md#footprints

import { vergenceToDistance } from "@lib/stereo";

export interface Pt {
  x: number;
  y: number;
}

// ---- corner projection ----------------------------------------------------

/**
 * Map the four frame corners `(0,0),(w,0),(w,h),(0,h)` through a ROW-MAJOR 3×3
 * homography (`affine`, 9 numbers — the telemetry channel's shape) into the
 * destination (wide/undistorted) pixel space; returns the quad in that
 * corner order. Returns null when `affine` is not a ≥9-length array, the frame
 * dims are non-positive, or any corner is degenerate (`w'≈0` / non-finite) — a
 * footprint that can't be projected is not drawn (never a guess).
 */
export function projectQuad(
  affine: readonly number[] | undefined | null,
  w: number,
  h: number,
): Pt[] | null {
  if (!affine || affine.length < 9 || !(w > 0) || !(h > 0)) return null;
  const [a, b, c, d, e, f, g, i, j] = affine as number[];
  const corners: Array<[number, number]> = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const out: Pt[] = [];
  for (const [x, y] of corners) {
    const wp = g! * x + i! * y + j!;
    if (!Number.isFinite(wp) || Math.abs(wp) < 1e-9) return null;
    const px = (a! * x + b! * y + c!) / wp;
    const py = (d! * x + e! * y + f!) / wp;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    out.push({ x: px, y: py });
  }
  return out;
}

/** An SVG `points` string for a projected quad (space-separated `x,y`). */
export function quadPoints(quad: Pt[]): string {
  return quad.map((p) => `${p.x},${p.y}`).join(" ");
}

// ---- pairing (color grouping) ---------------------------------------------

export type FootprintSide = "left" | "right";

const SIDE_TOKENS: Record<FootprintSide, readonly string[]> = {
  left: ["left", "l"],
  right: ["right", "r"],
};

/** Split a channel name into comparison segments (separators `-_/. ` AND
 *  camelCase / letter↔digit boundaries) — the timeline's segmenting, inlined so
 *  this module stays independent of it. */
function segments(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[-_/.\s]+/)
    .filter(Boolean);
}

/** The (side, base) of a stream, or null when it carries no side token. Unlike
 *  the timeline's `sideOf`, the BASE may be EMPTY (`"left"`/`"right"` alone) —
 *  that is the sole-stereo-pair key multi-fovea uses. */
export function footprintSide(
  name: string,
): { side: FootprintSide; base: string } | null {
  const segs = segments(name).map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    for (const side of ["left", "right"] as const) {
      if (SIDE_TOKENS[side].includes(segs[i]!)) {
        const base = [...segs.slice(0, i), ...segs.slice(i + 1)].join("-");
        return { side, base };
      }
    }
  }
  return null;
}

/** One color group: a stereo PAIR (`left` + `right`, one shared color + a depth
 *  readout) or a SOLO stream. `key` is the color-assignment key. */
export interface FootprintGroup {
  key: string;
  streams: string[];
  left: string | null;
  right: string | null;
}

/**
 * Group streams for coloring. Side-tagged streams sharing a base are paired iff
 * EXACTLY one left and one right claim that base (`left`/`right` → the empty-base
 * stereo pair); every other stream — side-less, a lone eye, or an ambiguous base
 * (two lefts, …) — is its own solo group. Deterministic (sorted by key).
 */
export function groupStreams(streams: readonly string[]): FootprintGroup[] {
  const byBase = new Map<string, { left: string[]; right: string[] }>();
  const solos: string[] = [];
  for (const s of streams) {
    const info = footprintSide(s);
    if (!info) {
      solos.push(s);
      continue;
    }
    const g = byBase.get(info.base) ?? { left: [], right: [] };
    g[info.side].push(s);
    byBase.set(info.base, g);
  }
  const groups: FootprintGroup[] = [];
  for (const [base, g] of byBase) {
    if (g.left.length === 1 && g.right.length === 1) {
      groups.push({
        key: `pair:${base}`,
        streams: [g.left[0]!, g.right[0]!],
        left: g.left[0]!,
        right: g.right[0]!,
      });
    } else {
      for (const s of [...g.left, ...g.right]) solos.push(s);
    }
  }
  for (const s of solos)
    groups.push({ key: s, streams: [s], left: null, right: null });
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/** stream → its group (for the per-box color + pair-depth lookup). */
export function groupByStream(
  groups: readonly FootprintGroup[],
): Map<string, FootprintGroup> {
  const m = new Map<string, FootprintGroup>();
  for (const g of groups) for (const s of g.streams) m.set(s, g);
  return m;
}

// ---- interval coloring ----------------------------------------------------

export interface ColorInterval {
  key: string;
  startNs: number;
  lastNs: number;
}

function intervalsOverlap(a: ColorInterval, b: ColorInterval): boolean {
  // Strict: intervals that merely touch at a point may reuse a color.
  return a.startNs < b.lastNs && b.startNs < a.lastNs;
}

/**
 * Greedy interval-coloring: each interval gets the LOWEST color index not used
 * by an already-colored interval it OVERLAPS. Disjoint intervals reuse indices;
 * overlapping ones get distinct indices. Deterministic (sorted by start, then
 * end, then key). Returns key → RAW color index (the component maps it into the
 * palette by `index % TARGET_COLORS.length`).
 */
export function assignColors(
  intervals: readonly ColorInterval[],
): Map<string, number> {
  const sorted = [...intervals].sort(
    (a, b) =>
      a.startNs - b.startNs || a.lastNs - b.lastNs || a.key.localeCompare(b.key),
  );
  const out = new Map<string, number>();
  const assigned: Array<ColorInterval & { color: number }> = [];
  for (const iv of sorted) {
    const used = new Set<number>();
    for (const a of assigned) if (intervalsOverlap(a, iv)) used.add(a.color);
    let c = 0;
    while (used.has(c)) c++;
    out.set(iv.key, c);
    assigned.push({ ...iv, color: c });
  }
  return out;
}

// ---- vergence-plane depth -------------------------------------------------

/**
 * The vergence-plane depth (same units as `baseline`, i.e. mm) for a stereo
 * pair from the two eyes' HORIZONTAL pointing angles (rad) + the container
 * baseline, via the shared stereo lib (`vergenceToDistance`). Returns:
 *   - null when either angle is missing (partner stream has no telemetry yet)
 *     or `baseline` is not a finite number > 0 (old container / unknown) — the
 *     UI shows "—";
 *   - Infinity when the rays are parallel/diverging (no convergence point).
 */
export function vergencePlaneDepth(
  angleLx: number | null | undefined,
  angleRx: number | null | undefined,
  baseline: number | null | undefined,
): number | null {
  if (typeof angleLx !== "number" || typeof angleRx !== "number") return null;
  if (typeof baseline !== "number" || !Number.isFinite(baseline) || baseline <= 0)
    return null;
  return vergenceToDistance(angleLx - angleRx, baseline);
}

/** Format a {@link vergencePlaneDepth} result for the hover label: "—" (null),
 *  "∞" (parallel/diverging), else the distance in metres to 2 dp. Baseline is mm
 *  so the depth is mm; ≥1 m reads in metres, otherwise mm. */
export function formatDepth(depth: number | null): string {
  if (depth == null) return "—";
  if (!Number.isFinite(depth)) return "∞";
  return depth >= 1000
    ? `${(depth / 1000).toFixed(2)} m`
    : `${Math.round(depth)} mm`;
}
