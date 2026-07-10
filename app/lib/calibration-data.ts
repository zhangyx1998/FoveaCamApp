// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Calibration-data enumeration + friendly-naming for the config window's
// "Calibration data" manager. Every persisted calibration document lives under
// one of three store directories, keyed as follows:
//
//   calibrate-intrinsic/<cameraKey>   — a `CameraCalibration` (center intrinsics)
//   calibrate-extrinsic/<cameraKey>   — an `ExtrinsicDataset` (per-fovea samples)
//   triples/<sha256>                  — a per-triple config doc (drift_l/drift_r,
//                                       zoom_override, baseline_mm, …)
//
// `<cameraKey>` is `getCameraKey` = `vendor_model_serial`; `<sha256>` is the
// hash of the L/C/R camera keys (mirrors `orchestrator/calibration.ts`'s
// `tripleConfigPath` — kept in lockstep here because that module is Vue-free /
// core-importing and must not be pulled into the renderer).
//
// The store is injected (`CalStore`) so this is unit-testable with an in-memory
// fake; the config window passes the renderer `Store` client (`list`/`read`/
// `clear`). Reads use the one-shot `Store.read` (no subscription) since this is
// a management view over many docs.

import { getCameraKey, ROLE, type Role } from "./camera-config.js";
import { sha256 } from "./util/hash.js";

export type CalCategory = "calibrate-intrinsic" | "calibrate-extrinsic" | "triples";

/**
 * The per-triple config document (`["triples", <hash>]`). `drift_l`/`drift_r`
 * are owned by calibrate-drift; `zoom_override` (0/absent = none; >0 = the
 * rig's known optical fovea↔wide zoom for this triple) feeds disparity-scope's
 * match-magnification resolution (see `vergence.matchMagnification`);
 * `baseline_mm` (>0 = this rig's physical stereo baseline) supersedes the
 * legacy app-level `baseline_distance_mm` for the disparity-scope verge limits
 * and the calibrate-* marker spacing (see {@link resolveBaseline}). The index
 * signature keeps any OTHER field (present or future) intact on write.
 */
export interface TripleConfig {
  drift_l?: number;
  drift_r?: number;
  zoom_override?: number;
  baseline_mm?: number;
  [key: string]: unknown;
}

/** The baseline (mm) used when neither the triple nor the legacy app config
 *  supplies one — the historical `baseline_distance_mm` default. */
export const DEFAULT_BASELINE_MM = 200;

/**
 * Resolve the physical stereo baseline (mm) for a triple under the RULED order
 * (2026-07-09): the per-triple `baseline_mm` wins, else the legacy app-level
 * `baseline_distance_mm`, else {@link DEFAULT_BASELINE_MM}. Each tier must be a
 * finite number > 0 to be accepted (a stored 0 / NaN / negative is treated as
 * unset and falls through), so existing rigs — which only ever set the legacy
 * app value — keep their exact behavior with zero migration steps. Pure +
 * unit-tested; the SINGLE place this precedence lives, shared by the
 * disparity-scope session (verge-limit derivation) and the calibrate-*
 * renderers (marker spacing).
 */
export function resolveBaseline(
  tripleBaseline?: number | null,
  legacyAppBaseline?: number | null,
): number {
  const ok = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  if (ok(tripleBaseline)) return tripleBaseline;
  if (ok(legacyAppBaseline)) return legacyAppBaseline;
  return DEFAULT_BASELINE_MM;
}

/**
 * Merge a patch onto a triple config WITHOUT clobbering fields it doesn't
 * mention — the write contract for editing `zoom_override` while preserving
 * `drift_l`/`drift_r` (and anything else the doc holds). A patch value of
 * `undefined` CLEARS that field (e.g. removing a zoom override). Pure, so the
 * round-trip is unit-testable; the config window achieves the same effect by
 * mutating one field of the `Store.open` reactive doc (which re-persists the
 * whole tracked object).
 */
export function mergeTripleConfig(
  existing: Readonly<Record<string, unknown>>,
  patch: Partial<TripleConfig>,
): TripleConfig {
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as TripleConfig;
}

/** The subset of the `Store` client this module needs — injected for tests. */
export interface CalStore {
  list(...segments: string[]): Promise<string[]>;
  read<T>(segments: string | string[], fallback: T): Promise<T>;
  clear(...segments: string[]): Promise<void>;
}

/** A currently-known camera (from the Welcome/probe enumeration) used only to
 *  resolve friendly names. `role` is "L"/"C"/"R" when a role has been assigned
 *  in manage-cameras. */
export type KnownCamera = {
  vendor: string;
  model: string;
  serial: string;
  role?: string;
};

/** One enumerated calibration document, ready to render. */
export interface CalEntry {
  category: CalCategory;
  /** Raw store key (cameraKey or triple hash) — the delete target. */
  key: string;
  /** Friendly, human-readable name (falls back to the key / short hash). */
  label: string;
  /** One-line metadata summary (record counts, date/RMS where available). */
  detail: string;
}

const CATEGORY_TITLE: Record<CalCategory, string> = {
  "calibrate-intrinsic": "Intrinsic",
  "calibrate-extrinsic": "Extrinsic",
  triples: "Triple",
};

export function categoryTitle(category: CalCategory): string {
  return CATEGORY_TITLE[category];
}

/** Friendly name for a `<cameraKey>` document, resolving against known cameras
 *  (by identity key). Falls back to the raw key when the device is unknown. */
export function cameraLabel(key: string, cameras: KnownCamera[]): string {
  const cam = cameras.find((c) => getCameraKey(c) === key);
  if (!cam) return key;
  const role = cam.role && cam.role in ROLE ? ` · ${ROLE[cam.role as Role]}` : "";
  return `${cam.vendor} ${cam.model} (${cam.serial})${role}`;
}

function shortHash(hash: string): string {
  return hash.length > 10 ? `${hash.slice(0, 10)}…` : hash;
}

function formatDate(d: unknown): string | null {
  const date = d instanceof Date ? d : typeof d === "string" ? new Date(d) : null;
  if (!date || isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/** The triple-config store hash for an L/C/R camera-key set. MUST match
 *  `orchestrator/calibration.ts`'s `tripleConfigPath` byte-for-byte (same JSON
 *  shape + key order) or friendly-name resolution silently misses. */
export async function tripleHash(keys: { L: string; C: string; R: string }): Promise<string> {
  return sha256(JSON.stringify({ L: keys.L, C: keys.C, R: keys.R }));
}

/**
 * Resolve a triple's friendly name by recomputing the hash from the currently-
 * known cameras (one each of role L/C/R) and matching it against `hash`. When
 * the known cameras don't reconstruct the hash (a different/absent rig), fall
 * back to the short hash so the entry is still selectable + deletable.
 */
export async function tripleLabel(hash: string, cameras: KnownCamera[]): Promise<string> {
  const byRole = (role: Role) => cameras.find((c) => c.role === role);
  const L = byRole("L");
  const C = byRole("C");
  const R = byRole("R");
  if (L && C && R) {
    const computed = await tripleHash({
      L: getCameraKey(L),
      C: getCameraKey(C),
      R: getCameraKey(R),
    });
    if (computed === hash)
      return `${L.serial} / ${C.serial} / ${R.serial}`;
  }
  return shortHash(hash);
}

/** Read an intrinsic doc's summary metadata (views · RMS · date). */
async function intrinsicDetail(store: CalStore, key: string): Promise<string> {
  const cal = await store.read<Record<string, unknown>>(
    ["calibrate-intrinsic", key],
    {},
  );
  const views = Array.isArray(cal.rvecs) ? cal.rvecs.length : null;
  const rms = typeof cal.rms === "number" && cal.rms > 0 ? cal.rms : null;
  const date = formatDate(cal.date);
  const parts: string[] = [];
  if (views !== null) parts.push(`${views} view${views === 1 ? "" : "s"}`);
  if (rms !== null) parts.push(`RMS ${rms.toFixed(3)}`);
  if (date) parts.push(date);
  return parts.length ? parts.join(" · ") : "empty";
}

/** Read an extrinsic dataset's summary metadata (sample count). */
async function extrinsicDetail(store: CalStore, key: string): Promise<string> {
  const ds = await store.read<unknown[]>(["calibrate-extrinsic", key], []);
  const n = Array.isArray(ds) ? ds.length : 0;
  return `${n} sample${n === 1 ? "" : "s"}`;
}

/** Read a triple doc's summary metadata (which fields are set). */
async function tripleDetail(store: CalStore, key: string): Promise<string> {
  const doc = await store.read<Record<string, unknown>>(["triples", key], {});
  const flags: string[] = [];
  if (typeof doc.drift_l === "number" || typeof doc.drift_r === "number")
    flags.push("drift");
  if (typeof doc.zoom_override === "number" && doc.zoom_override > 0)
    flags.push(`zoom ${(doc.zoom_override as number).toFixed(2)}×`);
  if (typeof doc.baseline_mm === "number" && doc.baseline_mm > 0)
    flags.push(`baseline ${Math.round(doc.baseline_mm as number)} mm`);
  return flags.length ? flags.join(" · ") : "no overrides";
}

/** Enumerate every stored calibration document across all three categories,
 *  with friendly labels + metadata, sorted category-then-label. */
export async function enumerateCalibrationData(
  store: CalStore,
  cameras: KnownCamera[],
): Promise<CalEntry[]> {
  const [intrinsicKeys, extrinsicKeys, tripleKeys] = await Promise.all([
    store.list("calibrate-intrinsic"),
    store.list("calibrate-extrinsic"),
    store.list("triples"),
  ]);

  const entries: CalEntry[] = [];

  for (const key of intrinsicKeys)
    entries.push({
      category: "calibrate-intrinsic",
      key,
      label: cameraLabel(key, cameras),
      detail: await intrinsicDetail(store, key),
    });

  for (const key of extrinsicKeys)
    entries.push({
      category: "calibrate-extrinsic",
      key,
      label: cameraLabel(key, cameras),
      detail: await extrinsicDetail(store, key),
    });

  for (const key of tripleKeys)
    entries.push({
      category: "triples",
      key,
      label: await tripleLabel(key, cameras),
      detail: await tripleDetail(store, key),
    });

  return entries;
}

/** Delete one calibration document (config window's DELETE action, after the
 *  confirm step). A no-op if absent. */
export function deleteCalibrationEntry(store: CalStore, entry: CalEntry): Promise<void> {
  return store.clear(entry.category, entry.key);
}
