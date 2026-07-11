// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Calibration-data enumeration + friendly-naming for the config window's "Calibration
// data" manager. Enumerates the three store dirs (calibrate-intrinsic/<id>,
// calibrate-extrinsic/<id>, triples/<hash>), skipping `.raw` artifacts. The triple
// hash mirrors orchestrator/calibration.ts's tripleConfigPath (kept in lockstep since
// that module is core-importing and must stay out of the renderer). Store injected.
// spec: docs/spec/calibration.md#calibration-data

import type { Point2d } from "core/Geometry";
import { getCameraKey, ROLE, type Role } from "./camera-config.js";
import {
  RECORD_STORES,
  datapointCount,
  isRecordId,
  orderRecordsLatestFirst,
  recordBelongsToTriple,
  stableHash,
  type CalibrationRecord,
} from "./calibration-records.js";

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
  /** Optional per-triple NICKNAME (calibration-records-v2). Shown in the
   *  triple-selector dialog and in the Welcome window when the connected rig
   *  matches this triple. Empty/absent = no nickname (fall back to serials). */
  nickname?: string;
  /** Per-eye drift offsets (angle-space `Point2d`) written by calibrate-drift
   *  (`saved.L`/`saved.R`, nullable). The type previously LIED (`number`) —
   *  calibration-review-2026-07-11 #16 — so the Device tab's `typeof === "number"`
   *  check never matched a real doc and the drift flag never showed. */
  drift_l?: Point2d | null;
  drift_r?: Point2d | null;
  zoom_override?: number;
  baseline_mm?: number;
  /** Per-triple trigger SETTLE hold (µs, v2.0) — the multi-fovea session reads
   *  this at activation and pushes it into every CMD_FRAME; the firmware holds
   *  the trigger this long after a stream SWITCH (0/absent = no hold). Stored
   *  in µs (protocol units); the settings UI edits it in ms. */
  settle_time_us?: number;
  /** Per-triple tracking-chain DELAY COMPENSATION (ms, SIGNED; 0/absent = off).
   *  Disparity-scope reads this at activation and chains an IMM motion predictor
   *  after the tracker: the downstream PID/mirrors consume the target's
   *  ESTIMATED position at `t_result + delay`. Positive = predict into the
   *  future (lead), negative = retrodict (lag). Stored + edited in ms. */
  delay_compensation_ms?: number;
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
  return stableHash(JSON.stringify({ L: keys.L, C: keys.C, R: keys.R }));
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

/**
 * The hash of the CURRENTLY-CONNECTED triple — the one formed by the known
 * cameras with roles L/C/R assigned (manage-cameras). Null when the connected
 * cameras don't form a complete role set (no rig, or a partial one). This is
 * the SAME source of truth `tripleLabel` uses to resolve friendly names, so the
 * Device-config tab's default selection matches the labels the user sees.
 */
export async function connectedTripleHash(
  cameras: KnownCamera[],
): Promise<string | null> {
  const byRole = (role: Role) => cameras.find((c) => c.role === role);
  const L = byRole("L");
  const C = byRole("C");
  const R = byRole("R");
  if (!L || !C || !R) return null;
  return tripleHash({
    L: getCameraKey(L),
    C: getCameraKey(C),
    R: getCameraKey(R),
  });
}

/** One configured triple, ordered for the Device-config selector. */
export interface TripleListItem {
  /** Store hash key (`["triples", key]`). */
  key: string;
  label: string;
  detail: string;
  /** True when this is the currently-connected rig. */
  connected: boolean;
}

/**
 * Order the configured triples for the Device-config selector: the CONNECTED
 * triple first, then the rest in the enumeration order they arrived in (which
 * `enumerateCalibrationData` already sorts by friendly label). Pure + stable
 * (a stable sort preserves the incoming order within each connected/not group),
 * so the "connected first, then by name" contract is unit-testable.
 */
export function orderTriples(
  entries: CalEntry[],
  connectedKey: string | null,
): TripleListItem[] {
  const items = entries
    .filter((e) => e.category === "triples")
    .map((e) => ({
      key: e.key,
      label: e.label,
      detail: e.detail,
      connected: e.key === connectedKey,
    }));
  return items.sort((a, b) =>
    a.connected === b.connected ? 0 : a.connected ? -1 : 1,
  );
}

/**
 * Resolve the Device tab's DEFAULT-selected triple: the connected triple when
 * one is configured, else the FIRST configured triple (most-recent/first by the
 * ordering) so the tab is never empty when triples exist. The returned item's
 * `connected` flag lets the UI show a "not connected" state on the fallback.
 * Null only when no triples are configured at all.
 */
export function defaultTripleSelection(
  ordered: TripleListItem[],
): TripleListItem | null {
  if (ordered.length === 0) return null;
  return ordered.find((t) => t.connected) ?? ordered[0];
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

/** True when a stored drift value is actually set: the real shape is a
 *  `Point2d` (calibrate-drift writes `{x, y}`, possibly null); a legacy plain
 *  number is still accepted. */
function driftSet(v: unknown): boolean {
  if (typeof v === "number") return true; // legacy scalar form
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Point2d).x === "number" &&
    typeof (v as Point2d).y === "number"
  );
}

/** Read a triple doc's summary metadata (which fields are set). */
async function tripleDetail(store: CalStore, key: string): Promise<string> {
  const doc = await store.read<Record<string, unknown>>(["triples", key], {});
  const flags: string[] = [];
  if (driftSet(doc.drift_l) || driftSet(doc.drift_r)) flags.push("drift");
  if (typeof doc.zoom_override === "number" && doc.zoom_override > 0)
    flags.push(`zoom ${(doc.zoom_override as number).toFixed(2)}×`);
  if (typeof doc.baseline_mm === "number" && doc.baseline_mm > 0)
    flags.push(`baseline ${Math.round(doc.baseline_mm as number)} mm`);
  if (typeof doc.settle_time_us === "number" && doc.settle_time_us > 0)
    flags.push(`settle ${((doc.settle_time_us as number) / 1000).toFixed(1)} ms`);
  if (
    typeof doc.delay_compensation_ms === "number" &&
    doc.delay_compensation_ms !== 0
  )
    flags.push(
      `delay ${(doc.delay_compensation_ms as number) > 0 ? "+" : ""}${(doc.delay_compensation_ms as number).toFixed(1)} ms`,
    );
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

  // Post-v2 both `calibrate-*` directories hold hash-keyed RECORDS (surfaced in
  // the per-triple records list, not here) plus `.raw` analysis artifacts. The
  // inventory lists only NON-record, non-`.raw` docs — i.e. any legacy
  // `<cameraKey>` doc an un-migrated dev store might still carry. Record files
  // and `.raw` artifacts are skipped.
  const legacyDoc = (key: string) => !isRecordId(key) && !key.endsWith(".raw");

  for (const key of intrinsicKeys) {
    if (!legacyDoc(key)) continue;
    entries.push({
      category: "calibrate-intrinsic",
      key,
      label: cameraLabel(key, cameras),
      detail: await intrinsicDetail(store, key),
    });
  }

  for (const key of extrinsicKeys) {
    if (!legacyDoc(key)) continue;
    entries.push({
      category: "calibrate-extrinsic",
      key,
      label: cameraLabel(key, cameras),
      detail: await extrinsicDetail(store, key),
    });
  }

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

// ---- Calibration records (calibration-records-v2) --------------------------

/** Read every calibration record from the store (config-window records list) —
 *  BOTH per-kind directories. Non-record files (`.raw` artifacts, any leftover
 *  legacy `<cameraKey>` doc) are filtered by the 32-hex id shape + an `inner`
 *  presence check. */
export async function enumerateRecords(store: CalStore): Promise<CalibrationRecord[]> {
  const recs: (CalibrationRecord | null)[] = [];
  for (const dir of RECORD_STORES) {
    const ids = (await store.list(dir)).filter(isRecordId);
    recs.push(
      ...(await Promise.all(
        ids.map((id) => store.read<CalibrationRecord | null>([dir, id], null)),
      )),
    );
  }
  return recs.filter(
    (r): r is CalibrationRecord => !!r && !!(r as CalibrationRecord).inner,
  );
}

/**
 * The records bound to the selected triple, latest-first. `liveKeys` = the
 * triple's live L/R camera keys (see {@link connectedEyeKeys}) — needed to
 * surface LEGACY records bound only by `cameraKey` (no triple hash). Empty for a
 * non-connected triple (only explicitly-hash-bound records then show).
 */
export function recordsForTriple(
  records: CalibrationRecord[],
  tripleHash: string,
  liveKeys: readonly string[],
): CalibrationRecord[] {
  return orderRecordsLatestFirst(
    records.filter((r) => recordBelongsToTriple(r, tripleHash, liveKeys)),
  );
}

/** The L/C/R camera identity keys of the currently-connected rig (for matching
 *  cameraKey-bound records — legacy extrinsic and per-camera intrinsic — to the
 *  connected triple). Includes the CENTER (C) so intrinsic records, which bind
 *  to the center camera, surface in the connected rig's record list. */
export function connectedEyeKeys(cameras: KnownCamera[]): string[] {
  const keys: string[] = [];
  for (const role of ["L", "C", "R"] as const) {
    const cam = cameras.find((c) => c.role === role);
    if (cam) keys.push(getCameraKey(cam));
  }
  return keys;
}

/** A record's list-row summary (datapoint count + locale calibration time). */
export interface RecordRow {
  id: string;
  /** Record kind — drives the list badge + the extrinsic-only visualizer gate. */
  kind: "extrinsic" | "intrinsic";
  count: number;
  /** ISO timestamp (ordering key). */
  created: string;
  /** Locale-formatted calibration time (row label). */
  localeTime: string;
  label?: string;
  /** True for an aggregated record (has source ids). */
  aggregated: boolean;
  /** Eye role from the first association, when known. */
  role?: string;
}

export function recordRow(rec: CalibrationRecord): RecordRow {
  const d = new Date(rec.outer.created);
  return {
    id: rec.id,
    kind: rec.inner.kind,
    count: datapointCount(rec),
    created: rec.outer.created,
    localeTime: isNaN(d.getTime()) ? rec.outer.created : d.toLocaleString(),
    label: rec.outer.label,
    aggregated: !!rec.outer.sources?.length,
    role: rec.outer.associations[0]?.role,
  };
}
