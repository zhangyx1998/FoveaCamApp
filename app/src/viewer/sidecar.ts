// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE viewer UI-state sidecar (node-free: types + JSON + validation,
// unit-tested): all viewer UI state persists to `<recording>.fcap.ui.json`, the
// only file the viewer writes (the `.fcap` is read-only). `classifySidecar`
// distinguishes absent/ok/corrupt; every field is type-checked + clamped.
// spec: docs/spec/viewer.md#sidecar

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
  /** GLOBAL 3D view mode (ruling 4, amended user 2026-07-09: one mode applies
   *  to EVERY L/R pair, not per pair). Old sidecars stored a `Record<base,mode>`
   *  map; `cleanThreeMode` collapses that to a single mode on read (no version
   *  bump — the migration is lossless-tolerant, not a corruption). */
  threeD: ThreeDMode;
  /** Preview panel height fraction of the window (0.15..0.9); the timeline
   *  panel gets the rest (ruling 6). 0 ⇒ timeline collapsed to the drawer. */
  split: number;
  /** Preview tile width, px (ruling 7). */
  tileWidth: number;
  /** Last playhead position, ns file-relative (restored on reopen, ruling 8). */
  playheadNs: number;
  /** Property panel visibility (UI round 2 ruling 4). Tolerant: an absent field
   *  in an older sidecar defaults CLOSED (no version bump). */
  panelOpen: boolean;
  /** Property panel width, px (UI round 2 ruling 4) — persisted when the user
   *  resizes it. Absent → DEFAULT_PANEL_WIDTH. */
  panelWidth: number;
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
/** Property-panel width bounds (UI round 2 ruling 4). */
export const MIN_PANEL_WIDTH = 220;
export const MAX_PANEL_WIDTH = 560;
export const DEFAULT_PANEL_WIDTH = 300;

export function defaultSidecar(): SidecarState {
  return {
    v: SIDECAR_VERSION,
    tracks: [],
    disabled: [],
    threeD: "disabled",
    split: DEFAULT_SPLIT,
    tileWidth: DEFAULT_TILE_WIDTH,
    playheadNs: 0,
    panelOpen: false,
    panelWidth: DEFAULT_PANEL_WIDTH,
  };
}

function clampPanelWidth(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_PANEL_WIDTH;
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(n)));
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

const isMode = (m: unknown): m is ThreeDMode =>
  typeof m === "string" && THREE_D_MODES.includes(m as ThreeDMode);

/** Coerce the stored `threeD` into the single GLOBAL mode (ruling 4 amendment).
 *  Accepts BOTH shapes tolerantly:
 *   - NEW: a bare mode string → itself (unknown string → "disabled").
 *   - OLD (per-pair map `{ base: mode }`): collapse to the first non-"disabled"
 *     value, else "disabled". Lossy-by-design (global mode replaces per-pair)
 *     and lossless-enough (the user re-picks once) — written back in the new
 *     shape on the next save, no confirm prompt (ruling 10 governs only
 *     corrupt/mismatch, not this upgrade). */
function cleanThreeMode(v: unknown): ThreeDMode {
  if (isMode(v)) return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const m of Object.values(v as Record<string, unknown>))
      if (isMode(m) && m !== "disabled") return m;
  }
  return "disabled";
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
    threeD: cleanThreeMode(o.threeD),
    split: clampSplit(o.split),
    tileWidth: clampTileWidth(o.tileWidth),
    playheadNs:
      typeof o.playheadNs === "number" && Number.isFinite(o.playheadNs)
        ? Math.max(0, o.playheadNs)
        : 0,
    // Tolerant: absent → CLOSED / default width (no version bump, ruling 4).
    panelOpen: o.panelOpen === true,
    panelWidth: clampPanelWidth(o.panelWidth),
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
