// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer UI-state SIDECAR (viewer-timeline.md ruling 8). ALL viewer UI state
// persists to `<recording>.fcap.ui.json` NEXT TO the container — the `.fcap`
// itself is opened READ-ONLY (source.ts uses fs flag "r"); the sidecar is the
// only file the viewer writes. This module is PURE (node-free: types + JSON +
// validation) so the round-trip and corrupt-file fallback are unit-tested with
// no fs; the worker owns the debounced read/write (worker.ts, node fs).
//
// Robustness (ruling 10 amendment): ABSENT → silently initialize (nothing to
// lose). PRESENT-but-corrupt or channel-MISMATCHED → the caller CONFIRMS with
// the user before reinitializing/overwriting (never silently discard a layout).
// `classifySidecar` distinguishes absent / ok / corrupt at the file level;
// channel-mismatch is decided in the UI (it needs the container's channels).
// Unknown keys are dropped and every field is type-checked + clamped so a
// hand-edited or version-skewed-but-parseable file can't wedge the UI.

import type { ThreeDMode } from "./timeline.js";
import { THREE_D_MODES } from "./timeline.js";

/** Bump when the shape changes incompatibly; older `v` → treated as corrupt
 *  (→ defaults) until a migration is added. */
export const SIDECAR_VERSION = 1;

export interface SidecarState {
  v: typeof SIDECAR_VERSION;
  /** The FULL track layout: rows of channel names (row 0 = master track). The
   *  sidecar is the source of truth after initialization (ruling 10) — greedy
   *  fit runs only to seed this; drags mutate it directly. */
  tracks: string[][];
  /** v-toggled OFF frame channels (ruling 5) — hidden from preview. */
  disabled: string[];
  /** pair base → 3D mode (ruling 4). */
  threeD: Record<string, ThreeDMode>;
  /** Preview panel height fraction of the window (0.15..0.9); the timeline
   *  panel gets the rest (ruling 6). 0 ⇒ timeline collapsed to the drawer. */
  split: number;
  /** Preview tile width, px (ruling 7). */
  tileWidth: number;
  /** Last playhead position, ns file-relative (restored on reopen, ruling 8). */
  playheadNs: number;
}

/** Panel-split bounds — the preview reserves a minimum height, the timeline can
 *  collapse to the drawer (split === COLLAPSED_SPLIT). */
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.92;
export const COLLAPSED_SPLIT = 0; // sentinel: timeline drawer collapsed
export const DEFAULT_SPLIT = 0.5;
export const MIN_TILE_WIDTH = 120;
export const MAX_TILE_WIDTH = 900;
export const DEFAULT_TILE_WIDTH = 320;

export function defaultSidecar(): SidecarState {
  return {
    v: SIDECAR_VERSION,
    tracks: [],
    disabled: [],
    threeD: {},
    split: DEFAULT_SPLIT,
    tileWidth: DEFAULT_TILE_WIDTH,
    playheadNs: 0,
  };
}

function clampSplit(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SPLIT;
  if (n <= COLLAPSED_SPLIT) return COLLAPSED_SPLIT;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, n));
}

function clampTileWidth(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_TILE_WIDTH;
  return Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, Math.round(n)));
}

function cleanTracks(v: unknown): string[][] {
  if (!Array.isArray(v)) return [];
  const out: string[][] = [];
  for (const row of v) {
    if (!Array.isArray(row)) continue;
    const clean = row.filter((c): c is string => typeof c === "string");
    out.push(clean);
  }
  return out;
}

function cleanThreeD(v: unknown): Record<string, ThreeDMode> {
  const out: Record<string, ThreeDMode> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, m] of Object.entries(v as Record<string, unknown>))
      if (typeof m === "string" && THREE_D_MODES.includes(m as ThreeDMode))
        out[k] = m as ThreeDMode;
  }
  return out;
}

function cleanDisabled(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string"))];
}

/** Coerce a parsed object that already passed the version check into a valid
 *  `SidecarState`, filling missing/invalid FIELDS from defaults. */
function coerceValid(o: Record<string, unknown>): SidecarState {
  return {
    v: SIDECAR_VERSION,
    tracks: cleanTracks(o.tracks),
    disabled: cleanDisabled(o.disabled),
    threeD: cleanThreeD(o.threeD),
    split: clampSplit(o.split),
    tileWidth: clampTileWidth(o.tileWidth),
    playheadNs:
      typeof o.playheadNs === "number" && Number.isFinite(o.playheadNs)
        ? Math.max(0, o.playheadNs)
        : 0,
  };
}

/** File-level load classification (ruling 10): ABSENT (no file) is silently
 *  initialized by the caller; CORRUPT (present but unparseable / wrong version
 *  / not an object) prompts a confirm before overwrite; OK carries the
 *  validated state (the caller still checks channel-mismatch against the
 *  container). `text === null` ⇒ the file did not exist. */
export type SidecarLoad =
  | { status: "absent" }
  | { status: "ok"; state: SidecarState }
  | { status: "corrupt" };

export function classifySidecar(text: string | null | undefined): SidecarLoad {
  if (text === null || text === undefined) return { status: "absent" };
  if (text.trim() === "") return { status: "corrupt" }; // present but empty
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { status: "corrupt" };
  const o = parsed as Record<string, unknown>;
  if (o.v !== SIDECAR_VERSION) return { status: "corrupt" }; // version skew
  return { status: "ok", state: coerceValid(o) };
}

/** Convenience for callers that only want a best-effort state (absent/corrupt
 *  → defaults). Never throws. */
export function parseSidecar(text: string | null | undefined): SidecarState {
  const load = classifySidecar(text);
  return load.status === "ok" ? load.state : defaultSidecar();
}

export function serializeSidecar(state: SidecarState): string {
  return JSON.stringify(state, null, 2);
}

/** The sidecar path for a container: `<recording>.fcap` → `<…>.fcap.ui.json`
 *  (proposal Design §Sidecar). Kept string-only so it's node-free. */
export function sidecarPathFor(fcapPath: string): string {
  return `${fcapPath}.ui.json`;
}
