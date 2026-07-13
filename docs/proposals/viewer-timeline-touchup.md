# fcap viewer — timeline touch-up wave (2026-07-13)

User-ruled 8-item touch-up of the viewer (`app/src/windows/ViewerWindow.vue`
+ `app/src/viewer/*`), on top of the sibling session's latest remote work.

## Rulings (user, 2026-07-13)

1. **Initial playhead** lands on the first meaningful frame (earliest block
   start) — at least one tile always shows on open. (Persisted playhead
   still wins when present; the default changes from t=0.)
2. **Tiles drag-rearrange** in the preview panel. Tile count == track count
   (placeholder tiles included); empty tracks auto-delete, so track ids stay
   stable across a recording.
3. **Time ruler** absolutely positioned on top of the track area; clicking
   it repositions the playhead.
4. **Track theme colors** — each track gets a theme color; the L/C/R role
   colors apply when a track's content maps to a side/center channel.
5. **X-axis (time) zoom** on the tracks view: ctrl+scroll (= macOS pinch)
   zooms centered on the cursor (nodegraph precedent); plain scroll pans X/Y;
   bleed areas before t=0 and after the end mark recording boundaries;
   out-of-bounds scroll is bouncy (rubber-band + spring back).
6. **Smooth playhead** during playback (currently jumps between worker
   position events).
7. **Design rule (standing):** inline buttons/interactive components drop
   always-visible borders/outlines; interactivity reads as a faint element
   background that darkens/lightens on hover/active. Applied across the
   viewer in this wave; recorded as the app-wide rule for future sweeps.
8. **Block drag between tracks** supports INSERTING a new track when
   hovering between two rows, with an insertion indicator.

## Pinned pure APIs (implementation contract)

### `app/src/viewer/timeline.ts` (additions; existing exports unchanged)

```ts
/** Earliest block start (ruling 1) — 0 when there are no blocks. */
export function firstMeaningfulNs(blocks: readonly ChannelBlock[]): number;

/** Insert `channel` as a NEW row at `insertBefore` (0..rows.length), removing
 *  it from its current row; empty rows drop; per-row start-time sort like
 *  moveBlock. Never collides (its own row). Returns a NEW layout. */
export function insertBlockAt(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  channel: string,
  insertBefore: number,
): string[][];

/** Track role from its channels: "L"/"R" via sideOf(), "C" via the wide
 *  designation names; null when mixed/none. */
export function trackRole(row: readonly string[]): "L" | "C" | "R" | null;

/** Track theme color: role colors (mirror tokens --role-l/-c/-r: cyan /
 *  orange / greenyellow) when trackRole() hits; otherwise a deterministic
 *  muted cycle by track index (distinct from the role hues). */
export function trackColor(row: readonly string[], index: number): string;

/** One tile SLOT per track (ruling 2): the track's active channel (or pair
 *  collapse) or a placeholder. A non-disabled pair renders in the FIRST
 *  (topmost) of its two tracks; the partner track's slot becomes a
 *  `pair-collapsed` placeholder naming the base. Stable: slot i ↔ track i. */
export type TileSlot =
  | { kind: "tile"; track: number; tile: Tile }
  | { kind: "placeholder"; track: number; reason: "no-frame" | "disabled" | "pair-collapsed"; label: string };
export function composeTileSlots(
  rows: readonly string[][],
  blocks: readonly ChannelBlock[],
  playheadNs: number,
  enabled: ReadonlySet<string>,
  pairModeOf: ReadonlyMap<string, { pair: ChannelPair; mode: ThreeDMode }>,
): TileSlot[];

/** Reconcile a persisted tile order (permutation of track indices) against
 *  the current track count: drop out-of-range, append missing in natural
 *  order. Identity when lengths/members already agree. */
export function reconcileTileOrder(order: readonly number[], trackCount: number): number[];
```

### `app/src/viewer/time-viewport.ts` (NEW, pure)

```ts
/** Visible time window in file-relative ns. t0 may go < 0 and t1 > duration
 *  only within the bleed allowance (rubber-band); hard bounds clamp there. */
export interface TimeViewport { t0: number; t1: number }

export const MIN_SPAN_NS: number;          // zoom-in floor (e.g. 1e6 = 1 ms)
export const BLEED_FRACTION: number;       // bleed = fraction of duration (each side)
export function fullViewport(durationNs: number): TimeViewport; // [0, duration]
export function bleedNs(durationNs: number): number;

/** Zoom by `factor` keeping the time at `anchorFrac` (0..1 of the tracks
 *  width) fixed (ruling 5; nodegraph zoomAt precedent). Clamps span to
 *  [MIN_SPAN_NS, duration + 2·bleed] and pans into hard bounds. */
export function zoomAt(vp: TimeViewport, factor: number, anchorFrac: number,
                       durationNs: number): TimeViewport;

/** Pan by `deltaNs` with rubber-band SOFTENING past [−bleed, duration+bleed]:
 *  inside bounds 1:1; past a bound the excess compresses (e.g. ×0.35^n). */
export function panSoft(vp: TimeViewport, deltaNs: number, durationNs: number): TimeViewport;

/** The spring-back target when a pan release left the viewport out of hard
 *  bounds — identity when already legal (UI animates toward it). */
export function settleTarget(vp: TimeViewport, durationNs: number): TimeViewport;

/** Pointer x ⟷ time under the viewport (replaces duration-relative mapping
 *  at every call site; timeline.ts nsAtClientX stays for compat). */
export function nsAtX(clientX: number, rectLeft: number, rectWidth: number,
                      vp: TimeViewport): number;                    // UNclamped
export function fracOf(ns: number, vp: TimeViewport): number;      // 0..1 (may exceed)

/** Ruler ticks (ruling 3): nice-number steps (1/2/5·10^k ns ladder incl.
 *  s/ms boundaries) targeting ~`targetPx` spacing; major ticks labeled
 *  (mm:ss.SSS resolution adapts to the step). */
export interface RulerTick { ns: number; major: boolean; label: string | null }
export function rulerTicks(vp: TimeViewport, widthPx: number, targetPx?: number): RulerTick[];

/** Smooth playhead (ruling 6): extrapolate the last worker position by
 *  wall-clock · rate while playing, clamped to duration; identity when
 *  paused/scrubbing. */
export function interpolatePlayhead(lastNs: number, lastAtMs: number, nowMs: number,
                                    rate: number, playing: boolean,
                                    durationNs: number): number;
```

## UI lane notes

- Tracks area: block x/width and the playhead position derive from
  `fracOf(...)` (viewport-aware) instead of duration-percent; bleed areas
  render as hatched/dimmed strips (they pan/zoom with the content); wheel:
  ctrl → `zoomAt` (cursor anchor), plain → `panSoft` X (deltaX) and native
  Y scroll of the track list (deltaY); pointer-release with out-of-bounds
  viewport animates to `settleTarget` (rAF spring, ~150–250 ms critically
  damped feel).
- Ruler: absolute overlay at the tracks top (above lanes, below playhead),
  ticks from `rulerTicks`; click/drag seeks via `nsAtX` (clamped to
  [0, duration]).
- Playhead: rAF loop while playing drives `interpolatePlayhead` between
  worker events; seek/pause snaps. The transport timecode keeps the raw
  worker position (no fake precision).
- Tiles: render `composeTileSlots` through the persisted tile order
  (`reconcileTileOrder`); placeholders show the track tag + reason; HTML
  drag or pointer-drag reorders slots (sidecar-persisted, ruling 2).
- Block drag (ruling 8): existing row-drop keeps `moveBlock`; hovering the
  BOUNDARY between lanes (a thin hit zone) shows an insertion line and drops
  via `insertBlockAt`.
- Sidecar: `tileOrder?: number[]` added; initial playhead falls back to
  `firstMeaningfulNs(blocks)` when no persisted playhead exists (ruling 1).
- Style rule (ruling 7): viewer-wide sweep — `bar-btn`, transport controls,
  tile heads, lane tags, panel/export/dialog buttons lose constant
  borders/outlines; interactive surfaces get `background: transparent` at
  rest → faint bg on hover → slightly stronger on active (respect existing
  color tokens; focus-visible outlines STAY for a11y). Recorded as the
  standing app-wide rule in the design docs.

## AS SHIPPED (2026-07-13, two-lane wave)

All 8 rulings landed; gates green (vue-tsc, vitest 1407/1407 across 133
files, vite build, boundaries). Decisions of record:

- **Pure lane** — timeline.ts +194 lines (all pinned fns), time-viewport.ts
  (MIN_SPAN_NS = 1 ms, BLEED_FRACTION = 0.05, rubber-band resistance ×0.35,
  `zoomAt` factor>1 = zoom in matching the nodegraph convention), 73 new
  unit tests. `no-frame` placeholders label the whole track's channel list;
  `trackRole` ignores role-less channels unless roles conflict.
- **UI lane** — ViewerWindow.vue +881/−173: every x-mapping through
  `fracOf`/`nsAtX`; bleed strips render only when the viewport shows past a
  bound; wheel = ctrl→zoom-at-cursor, horizontal→panSoft, vertical falls
  through to native track-list scroll; 150 ms gesture-idle triggers the
  settle animation. Transport timecode stays on the RAW worker clock — only
  the playhead line glides (`smoothPositionNs`); tiles/overlays derive from
  the raw position so nothing re-computes per frame. Tile drag: tile HEADER
  is the handle, placeholders are targets-only, insertion index by slot
  mid-x with a 2 px indicator; order persists as sidecar `tileOrder`
  (conservative parser + tests). Block insertion: between-lane hit zones →
  `insertBlockAt`. Initial playhead: persisted-wins, else
  `firstMeaningfulNs`. Ruling-7 sweep across ViewerWindow, ExportDialog,
  ExportTray (StatsPopover had nothing bordered); recorded as standing
  principle #5 in docs/design/design-language.md.
- Viewport is deliberately NOT persisted this wave (resets to full on open).

RIG/EYEBALL (stage-f Viewer items): trackpad pinch/pan feel, rubber-band +
settle spring, ruler legibility across zoom depths, track hues vs
saturated/disabled styling, smooth playhead at all rates, tile drag feel,
insertion indicator discoverability, ruling-7 sweep coherence.
