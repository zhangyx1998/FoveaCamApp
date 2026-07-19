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

/** Greedy min-track interval packing: start-sorted, first-fit onto
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

/** The INITIAL track layout (run only at sidecar init/reset): the
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
 *  back) an overlapping placement. `targetRow === rows.length`
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
 *  (the sidecar is the source of truth; no auto-pack re-run). The
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
 *  WITHOUT persisting (never silently discard/overwrite a user
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
 *  "mismatched ui metadata" trigger for a confirm prompt. */
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

/** 3D view mode for an L/R pair. EXTENSIBLE: a future `dlp` (or
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
 *  playhead share one mapping and it is unit-tested:
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

// ---- timeline touch-up additions ------------------------------------------

/** Earliest block start — the initial playhead lands here so at
 *  least one tile shows on open. 0 when there are no blocks. */
export function firstMeaningfulNs(blocks: readonly ChannelBlock[]): number {
  let min = Infinity;
  for (const b of blocks) if (b.startNs < min) min = b.startNs;
  return Number.isFinite(min) ? min : 0;
}

/** Insert `channel` as a NEW row at `insertBefore` (0..rows.length), removing
 *  it from its current row; now-empty rows drop; per-row start-time sort like
 *  `moveBlock`. Its own fresh row never collides. Returns a NEW layout.
 *  `insertBefore` indexes the ORIGINAL rows (a new row is spliced at that
 *  position before empties are dropped), so hovering the boundary above row i
 *  inserts at i. */
export function insertBlockAt(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  channel: string,
  insertBefore: number,
): string[][] {
  const byStart = new Map(blocks.map((b) => [b.channel, b.startNs]));
  // Remove the channel everywhere; keep indices aligned to `rows` (no drop yet).
  const next: string[][] = rows.map((r) => r.filter((c) => c !== channel));
  const idx = Math.max(0, Math.min(insertBefore, next.length));
  next.splice(idx, 0, [channel]);
  return next
    .filter((r) => r.length > 0)
    .map((r) =>
      [...r].sort(
        (a, b) => (byStart.get(a) ?? 0) - (byStart.get(b) ?? 0) || a.localeCompare(b),
      ),
    );
}

/** The L/C/R role of a single channel: L/R via `sideOf()`, C via the wide/
 *  center designation names, else null. */
function channelRole(channel: string): "L" | "C" | "R" | null {
  const s = sideOf(channel);
  if (s) return s.side === "left" ? "L" : "R";
  if ((WIDE_DESIGNATION_NAMES as readonly string[]).includes(channel.toLowerCase()))
    return "C";
  return null;
}

/** Track role from its channels: the single role shared by every
 *  role-bearing channel on the row ("L"/"R" via `sideOf()`, "C" via the wide
 *  designation names). null when the row mixes roles or carries none;
 *  role-less channels don't veto an otherwise-uniform role. */
export function trackRole(row: readonly string[]): "L" | "C" | "R" | null {
  let found: "L" | "C" | "R" | null = null;
  for (const ch of row) {
    const r = channelRole(ch);
    if (r === null) continue;
    if (found === null) found = r;
    else if (found !== r) return null; // mixed → no single role
  }
  return found;
}

/** Role colors mirror tokens.css --role-l/-c/-r (and profiler ROLE_COLORS). */
const ROLE_TRACK_COLORS: Record<"L" | "C" | "R", string> = {
  L: "cyan",
  C: "orange",
  R: "greenyellow",
};

/** Muted, deterministic non-role track palette — desaturated hues that won't
 *  compete with the saturated role colors or warn/error accents. Cycled by
 *  track index. */
const MUTED_TRACK_COLORS: readonly string[] = [
  "#7c8aa5", // muted blue
  "#a58a7c", // muted terracotta
  "#8aa57c", // muted sage
  "#9a7ca5", // muted mauve
  "#a5a07c", // muted khaki
  "#7ca5a0", // muted teal
  "#a57c92", // muted rose
  "#8f8fa0", // muted slate
];

/** Track theme color: the L/C/R role color when `trackRole()` hits,
 *  otherwise a deterministic muted cycle by track index (distinct from the role
 *  hues). */
export function trackColor(row: readonly string[], index: number): string {
  const role = trackRole(row);
  if (role) return ROLE_TRACK_COLORS[role];
  const n = MUTED_TRACK_COLORS.length;
  return MUTED_TRACK_COLORS[((index % n) + n) % n]!;
}

/** One tile SLOT per track: slot i ↔ track i. The track's active
 *  (spanning + enabled) channel becomes a `tile`; a non-`disabled` pair renders
 *  as ONE pair tile in the TOPMOST of its two active tracks, the partner active
 *  track getting a `pair-collapsed` placeholder labeled with the base. A track
 *  whose spanning channel is disabled gets a `disabled` placeholder (label =
 *  that channel); a track with no channel at the playhead gets `no-frame`
 *  (label = the row's channels). Reuses `activeChannels` semantics +
 *  `pairDecodeChannels`. */
export type TileSlot =
  | { kind: "tile"; track: number; tile: Tile }
  | {
      kind: "placeholder";
      track: number;
      reason: "no-frame" | "disabled" | "pair-collapsed";
      label: string;
    };

export function composeTileSlots(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  playheadNs: number,
  enabled: ReadonlySet<string>,
  pairModeOf: ReadonlyMap<string, { pair: ChannelPair; mode: ThreeDMode }>,
): TileSlot[] {
  const byName = new Map(blocks.map((b) => [b.channel, b]));
  const spans = (ch: string): boolean => {
    const b = byName.get(ch);
    return !!b && playheadNs >= b.startNs && playheadNs <= b.lastNs;
  };
  // Per-row spanning channel (regardless of enabled) — at most one (rows never
  // overlap). And the active (spanning + enabled) channel, mirroring
  // activeChannels' first-match semantics.
  const spanCh: (string | null)[] = rows.map((row) => row.find(spans) ?? null);
  const activeCh: (string | null)[] = rows.map(
    (row) => row.find((ch) => enabled.has(ch) && spans(ch)) ?? null,
  );
  // Active tracks per non-disabled pair (base → ascending row indices). The
  // topmost hosts the pair tile; the rest collapse.
  const pairActiveTracks = new Map<string, number[]>();
  activeCh.forEach((ch, t) => {
    if (!ch) return;
    const info = pairModeOf.get(ch);
    if (info && info.mode !== "disabled") {
      const arr = pairActiveTracks.get(info.pair.base) ?? [];
      arr.push(t);
      pairActiveTracks.set(info.pair.base, arr);
    }
  });

  return rows.map((row, t): TileSlot => {
    const ch = activeCh[t];
    if (!ch) {
      const span = spanCh[t];
      if (span)
        return { kind: "placeholder", track: t, reason: "disabled", label: span };
      return { kind: "placeholder", track: t, reason: "no-frame", label: row.join(", ") };
    }
    const info = pairModeOf.get(ch);
    if (info && info.mode !== "disabled") {
      const tracks = pairActiveTracks.get(info.pair.base)!;
      if (t === tracks[0]) {
        return {
          kind: "tile",
          track: t,
          tile: {
            kind: "pair",
            pair: info.pair,
            mode: info.mode as Exclude<ThreeDMode, "disabled">,
            channels: pairDecodeChannels(info.pair, info.mode),
          },
        };
      }
      return {
        kind: "placeholder",
        track: t,
        reason: "pair-collapsed",
        label: info.pair.base,
      };
    }
    return { kind: "tile", track: t, tile: { kind: "single", channel: ch, channels: [ch] } };
  });
}

/** Reconcile a persisted tile order (a permutation of track indices) against
 *  the current track count: drop out-of-range/duplicate entries, append missing
 *  indices in natural order. Value-identity when order already agrees. */
export function reconcileTileOrder(
  order: readonly number[],
  trackCount: number,
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const i of order) {
    if (Number.isInteger(i) && i >= 0 && i < trackCount && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  for (let i = 0; i < trackCount; i++) if (!seen.has(i)) out.push(i);
  return out;
}
