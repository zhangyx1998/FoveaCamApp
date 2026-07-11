// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE multi-track timeline geometry (Vue/Node/core-free, unit-tested):
// blocks, master detection, layout packing, 3D pairing, tile order, decode set.
// spec: docs/spec/viewer.md#timeline

/** One frame channel's block on the timeline. Times are file-relative ns
 *  (0..durationNs), matching the scrub domain. `startNs`/`lastNs` are the
 *  first/last message log-times of the channel (channels armed mid-recording
 *  start mid-timeline; truncated files span what was recovered). */
export interface ChannelBlock {
  channel: string;
  startNs: number;
  lastNs: number;
}

// ---- master detection -----------------------------------------------------

/** Recorder wide/center designation names (lower-cased, exact segment match).
 *  manual-control → "center"; multi-fovea wide singleton → "wide". */
export const WIDE_DESIGNATION_NAMES = ["center", "wide"] as const;

export interface MasterResult {
  /** The master channel topic, or null when there are no frame channels. */
  channel: string | null;
  /** True when a channel matched the recorder's wide/center designation;
   *  false = we fell back to the first frame channel (UI shows a hint). */
  designated: boolean;
}

/** Pick the master (top) track. A frame channel whose name matches the wide
 *  designation wins (first in `frameChannels` order); otherwise the first
 *  frame channel, flagged `designated: false` so the UI can hint it. */
export function detectMaster(frameChannels: readonly string[]): MasterResult {
  const byName = frameChannels.find((c) =>
    (WIDE_DESIGNATION_NAMES as readonly string[]).includes(c.toLowerCase()),
  );
  if (byName) return { channel: byName, designated: true };
  return { channel: frameChannels[0] ?? null, designated: false };
}

// ---- 3D pairing -----------------------------------------------------------

export type Side = "left" | "right";

/** Side tokens recognised as a WHOLE segment (delimited by start/end or one of
 *  `-_/. ` or a case boundary). Single-letter `l`/`r` pair only when they are a
 *  standalone segment AND leave a non-empty shared base — so "center" never
 *  pairs, "l" alone never pairs, and "left-cam"/"right-cam" do. */
const SIDE_TOKENS: Record<Side, readonly string[]> = {
  left: ["left", "l"],
  right: ["right", "r"],
};

/** Split a channel name into comparison segments: separators `-_/. ` AND
 *  camelCase / letter↔digit boundaries (so "leftCam", "camL", "cam1" split). */
function segments(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[-_/.\s]+/)
    .filter(Boolean);
}

/** The (side, base) of a channel, or null if it carries no side token or the
 *  base would be empty. Base = the remaining segments joined by "-", lower-
 *  cased (so "Left-Cam" and "right_cam" share base "cam"). */
export function sideOf(name: string): { side: Side; base: string } | null {
  const segs = segments(name).map((s) => s.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    for (const side of ["left", "right"] as const) {
      if (SIDE_TOKENS[side].includes(segs[i]!)) {
        const base = [...segs.slice(0, i), ...segs.slice(i + 1)].join("-");
        if (base) return { side, base };
      }
    }
  }
  return null;
}

export interface ChannelPair {
  /** Shared base name (the pair's stable key for 3D-mode persistence). */
  base: string;
  left: string;
  right: string;
}

/** Detect L/R pairs among frame channels. A base pairs ONLY when exactly one
 *  left and exactly one right claim it — an ambiguous base (two lefts, etc.)
 *  never false-pairs. Deterministic order (by base). */
export function detectPairs(channels: readonly string[]): ChannelPair[] {
  const groups = new Map<
    string,
    { left?: string; right?: string; ambiguous?: boolean }
  >();
  for (const ch of channels) {
    const s = sideOf(ch);
    if (!s) continue;
    const g = groups.get(s.base) ?? {};
    if (g[s.side]) g.ambiguous = true;
    else g[s.side] = ch;
    groups.set(s.base, g);
  }
  const pairs: ChannelPair[] = [];
  for (const [base, g] of groups)
    if (!g.ambiguous && g.left && g.right)
      pairs.push({ base, left: g.left, right: g.right });
  return pairs.sort((a, b) => a.base.localeCompare(b.base));
}

// ---- auto-pack + overrides ------------------------------------------------

function overlaps(a: ChannelBlock, b: ChannelBlock): boolean {
  // Strict overlap: blocks that merely touch at a point may share a row.
  return a.startNs < b.lastNs && b.startNs < a.lastNs;
}

/** Greedy min-track interval packing (ruling 2): start-sorted, first-fit onto
 *  the fewest rows with no overlap. Optimal for interval scheduling (row count
 *  == max concurrency). Deterministic tie-break by channel name. Returns rows
 *  of channel names. */
export function autoPack(blocks: readonly ChannelBlock[]): string[][] {
  const sorted = [...blocks].sort(
    (a, b) =>
      a.startNs - b.startNs ||
      a.lastNs - b.lastNs ||
      a.channel.localeCompare(b.channel),
  );
  const rows: ChannelBlock[][] = [];
  for (const b of sorted) {
    const row = rows.find((r) => r.every((x) => !overlaps(x, b)));
    if (row) row.push(b);
    else rows.push([b]);
  }
  return rows.map((r) => r.map((b) => b.channel));
}

/** The INITIAL track layout (ruling 10: run only at sidecar init/reset): the
 *  master on row 0, the remaining frame blocks greedily auto-packed onto the
 *  fewest non-overlapping rows below. Deterministic. Returns rows of channel
 *  names (row 0 = master track). After initialization the sidecar's stored
 *  layout is authoritative — this is NOT re-run over user placement. */
export function initialLayout(
  blocks: readonly ChannelBlock[],
  master: string | null,
): string[][] {
  const hasMaster = master !== null && blocks.some((b) => b.channel === master);
  const rest = blocks.filter((b) => b.channel !== master);
  const packed = autoPack(rest);
  if (hasMaster) return [[master!], ...packed];
  return packed.length > 0 ? packed : [[]];
}

/** Would dropping `channel`'s block onto `targetRow` collide with another
 *  block already on that row? The UI calls this on drag-drop to REFUSE (snap
 *  back) an overlapping placement (ruling 2). `targetRow === rows.length`
 *  (a brand-new bottom row) never collides. */
export function dropCollides(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  channel: string,
  targetRow: number,
): boolean {
  const byName = new Map(blocks.map((b) => [b.channel, b]));
  const b = byName.get(channel);
  if (!b) return false;
  const row = rows[targetRow];
  if (!row) return false; // a brand-new bottom row never collides
  return row.some((c) => c !== channel && overlaps(byName.get(c)!, b));
}

/** Move `channel`'s block to `targetRow`, mutating the stored layout directly
 *  (ruling 10 — the sidecar is the source of truth; no auto-pack re-run). The
 *  block is removed from its current row and appended to `targetRow`
 *  (`targetRow === rows.length` creates a new bottom track); now-empty rows are
 *  dropped ("removing tracks as needed"). Rows are re-sorted by start time.
 *  Returns a NEW layout; callers gate on `dropCollides` first (a colliding
 *  move is a no-op here only if the caller skips it). */
export function moveBlock(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  channel: string,
  targetRow: number,
): string[][] {
  const byStart = new Map(blocks.map((b) => [b.channel, b.startNs]));
  // Empty each row of the channel first (indices still align to `rows`).
  const next: string[][] = rows.map((r) => r.filter((c) => c !== channel));
  if (targetRow >= next.length) next.push([channel]);
  else next[targetRow]!.push(channel);
  return next
    .filter((r) => r.length > 0)
    .map((r) =>
      [...r].sort(
        (a, b) => (byStart.get(a) ?? 0) - (byStart.get(b) ?? 0) || a.localeCompare(b),
      ),
    );
}

/** Reconcile a stored layout against the container's ACTUAL frame channels
 *  WITHOUT persisting (ruling 10: never silently discard/overwrite a user
 *  layout on mismatch). Channels in the layout that no longer exist are
 *  dropped; present channels missing from the layout are appended to new
 *  bottom rows so playback still shows them. The caller uses `layoutMismatch`
 *  to decide whether to prompt for a reset. */
export function reconcileLayout(
  rows: readonly string[][],
  frameChannels: readonly string[],
): string[][] {
  const present = new Set(frameChannels);
  const kept = rows
    .map((r) => r.filter((c) => present.has(c)))
    .filter((r) => r.length > 0);
  const seen = new Set(kept.flat());
  for (const ch of frameChannels) if (!seen.has(ch)) kept.push([ch]);
  return kept.length > 0 ? kept : [[]];
}

/** Do the channels named in a stored layout differ from the container's frame
 *  channels? (extra layout channels OR missing container channels) — the
 *  ruling-10 "mismatched ui metadata" trigger for a confirm prompt. */
export function layoutMismatch(
  rows: readonly string[][],
  frameChannels: readonly string[],
): boolean {
  const inLayout = new Set(rows.flat());
  const present = new Set(frameChannels);
  if (inLayout.size !== present.size) return true;
  for (const c of present) if (!inLayout.has(c)) return true;
  return false;
}

// ---- tiles ----------------------------------------------------------------

/** 3D view mode for an L/R pair (ruling 4). EXTENSIBLE: a future `dlp` (or
 *  other 3D tech) is one more case here + a decode/render branch, never a
 *  rewrite. `disabled` = two independent tiles; the rest collapse to one. */
export type ThreeDMode = "disabled" | "left-only" | "right-only" | "anaglyph";

export const THREE_D_MODES: readonly ThreeDMode[] = [
  "disabled",
  "left-only",
  "right-only",
  "anaglyph",
];

export interface SingleTile {
  kind: "single";
  channel: string;
  /** Channels whose decoded frame this tile renders (== [channel]). */
  channels: string[];
}
export interface PairTile {
  kind: "pair";
  pair: ChannelPair;
  mode: Exclude<ThreeDMode, "disabled">;
  /** Channels the tile needs decoded: both for anaglyph, one for L/R-only. */
  channels: string[];
}
export type Tile = SingleTile | PairTile;

/** The channels a non-disabled pair mode needs decoded. */
function pairDecodeChannels(pair: ChannelPair, mode: ThreeDMode): string[] {
  switch (mode) {
    case "left-only":
      return [pair.left];
    case "right-only":
      return [pair.right];
    case "anaglyph":
      return [pair.left, pair.right];
    default:
      return [pair.left, pair.right];
  }
}

/** Build the ordered preview tiles from the Z-ordered ACTIVE channels (the
 *  channels whose block spans the playhead AND are enabled, already in master-
 *  first, top→bottom row order). A non-`disabled` pair collapses to ONE tile at
 *  its FIRST-encountered (higher) position; `disabled` pairs stay two tiles. */
export function composeTiles(
  orderedChannels: readonly string[],
  pairModeOf: ReadonlyMap<string, { pair: ChannelPair; mode: ThreeDMode }>,
): Tile[] {
  const tiles: Tile[] = [];
  const seen = new Set<string>();
  for (const ch of orderedChannels) {
    if (seen.has(ch)) continue;
    const info = pairModeOf.get(ch);
    if (!info || info.mode === "disabled") {
      tiles.push({ kind: "single", channel: ch, channels: [ch] });
      seen.add(ch);
      continue;
    }
    seen.add(info.pair.left);
    seen.add(info.pair.right);
    tiles.push({
      kind: "pair",
      pair: info.pair,
      mode: info.mode as Exclude<ThreeDMode, "disabled">,
      channels: pairDecodeChannels(info.pair, info.mode),
    });
  }
  return tiles;
}

/** The set of frame channels the worker must DECODE (the enabled-set protocol
 *  shape). Every enabled frame channel, MINUS the hidden side of any pair whose
 *  mode is left-/right-only (that side is never displayed, so skip its decode).
 *  Playhead-independent — during playback frames stream in for the whole set.
 *  Sorted + de-duplicated for a stable wire payload. */
export function decodeSet(
  enabledFrameChannels: readonly string[],
  pairModeOf: ReadonlyMap<string, { pair: ChannelPair; mode: ThreeDMode }>,
): string[] {
  const out = new Set<string>();
  for (const ch of enabledFrameChannels) {
    const info = pairModeOf.get(ch);
    if (info) {
      if (info.mode === "left-only" && ch === info.pair.right) continue;
      if (info.mode === "right-only" && ch === info.pair.left) continue;
    }
    out.add(ch);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// ---- playhead ⟷ time geometry ---------------------------------------------

/** Map a pointer `clientX` over the timeline track area to a file-relative ns,
 *  CLAMPED to [0, durationNs]. Pure so the click-to-seek and the draggable
 *  playhead (UI round 2 ruling 1) share one mapping and it is unit-tested:
 *  before the left edge → 0, past the right edge → durationNs, degenerate
 *  geometry (zero width / zero duration) → 0. */
export function nsAtClientX(
  clientX: number,
  rectLeft: number,
  rectWidth: number,
  durationNs: number,
): number {
  if (!(rectWidth > 0) || !(durationNs > 0)) return 0;
  const frac = Math.min(1, Math.max(0, (clientX - rectLeft) / rectWidth));
  return frac * durationNs;
}

/** The channels active at `playheadNs` in Z order (master row first, then
 *  top→bottom), filtered to `enabled`. At most one block per row spans a given
 *  playhead (rows never overlap), so each row contributes ≤ 1 channel. */
export function activeChannels(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  playheadNs: number,
  enabled: ReadonlySet<string>,
): string[] {
  const byName = new Map(blocks.map((b) => [b.channel, b]));
  const out: string[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (!enabled.has(ch)) continue;
      const b = byName.get(ch);
      if (b && playheadNs >= b.startNs && playheadNs <= b.lastNs) {
        out.push(ch);
        break; // one active block per row
      }
    }
  }
  return out;
}
