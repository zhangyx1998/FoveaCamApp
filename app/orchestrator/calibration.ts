// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side calibration loader. A setAction-free / Store-free port of
// the renderer `useCalibratedTriple`: matches L/C/R by stored role, loads the
// center intrinsic (→ Undistort) and each fovea's extrinsic dataset (→ V2A/A2V
// regressions + A2H via findPinholeProjection), and the triple config. Returns
// the structural `ConversionInputs` (+ cameras) that `useCoordinateConversions`
// consumes — so the orchestrator control loops reuse the same conversion math.

import { Undistort } from "core/Vision";
import type { CameraCalibration } from "core/Vision";
import Regression, { type RegressionConfig } from "core/Regression";
import type { Camera } from "core/Aravis";
import type { Point2d } from "core/Geometry";
import { getCameraKey, type Role } from "@lib/camera-config";
import { findPinholeProjection } from "@lib/marker";
import {
  useCoordinateConversions,
  type ConversionInputs,
  type CoordinateConversions,
} from "@lib/coordinate-conversions";
import type { ExtrinsicDataset } from "@lib/camera-config";
import {
  EXTRINSIC_STORE,
  INTRINSIC_STORE,
  isRecordId,
  resolveActiveDataset,
  resolveActiveIntrinsic,
  stableHash,
  type CalibrationRecord,
} from "@lib/calibration-records";
import { cameraConfigPath } from "./camera.js";
import { read, list } from "./store-hub.js";
import { timeSpan } from "./diagnostics.js";
import { matchTriple, retryUntil, type CameraLease } from "./registry.js";
import type { ServerSession } from "./runtime.js";
import type { Contract } from "@lib/orchestrator/protocol";

function validate(cal?: Partial<CameraCalibration>): cal is CameraCalibration {
  return Boolean(
    cal &&
      cal.sensor_size &&
      cal.camera_matrix &&
      cal.dist_coeffs &&
      cal.rvecs &&
      cal.tvecs,
  );
}

// Exported for calibrate-intrinsic's session (§7.1 S1b) — it needs the same
// "read + validate + build Undistort" logic to show a camera's FOV/date in
// its picker list, without duplicating the validation rules. Parameter
// widened to the same `Pick` `cameraConfigPath`/`getCameraKey` already use —
// the picker list only has plain `CameraInfo`s, not opened `Camera` handles.
export async function loadIntrinsic(
  camera: Pick<Camera, "vendor" | "model" | "serial">,
): Promise<{ undistort: Undistort | null; date: Date | null; rms: number | null }> {
  const cal = await loadIntrinsicCalibration(getCameraKey(camera));
  const date = cal.date instanceof Date ? cal.date : null;
  // Additive (proposal item 5): absent on calibrations solved before the core
  // returned it, so degrade to null rather than 0 (which would read as "perfect").
  const rms = typeof cal.rms === "number" ? cal.rms : null;
  try {
    if (validate(cal)) return { undistort: new Undistort(cal), date, rms };
  } catch (e) {
    console.warn("[calibration] failed to build undistort:", e);
  }
  return { undistort: null, date, rms };
}

/**
 * Resolve a camera's active intrinsic `CameraCalibration` under the records
 * model (calibration-records-v2, schema v2): the LATEST intrinsic RECORD (by
 * `created`) associated with this camera's key, reconstituted into a full
 * `CameraCalibration` (`inner.calibration` payload + `date` from `outer.created`
 * — the Mats revive through the store codec). Falls back to the LEGACY flat doc
 * (`["calibrate-intrinsic", <cameraKey>]`) for an un-migrated dev store; the
 * v1→v2 migration wraps every legacy doc as a record, so the fallback normally
 * finds nothing. Read-only fallback (never re-written by the load path).
 */
async function loadIntrinsicCalibration(
  cameraKey: string,
): Promise<Partial<CameraCalibration>> {
  const names = (await list(INTRINSIC_STORE)).filter(isRecordId);
  const records = await Promise.all(
    names.map((id) => read<CalibrationRecord | null>([INTRINSIC_STORE, id], null)),
  );
  const valid = records.filter(
    (r): r is CalibrationRecord => !!r && r.inner?.kind === "intrinsic",
  );
  const active = resolveActiveIntrinsic(valid, cameraKey);
  if (active)
    return { ...active.calibration, date: new Date(active.created) } as Partial<CameraCalibration>;
  return read<Partial<CameraCalibration>>(["calibrate-intrinsic", cameraKey], {});
}

/** Minimum extrinsic poses for the cubic fit (calibration-review-2026-07-11
 *  #14): the per-axis cubic design matrix has 10 terms, so fewer than 10
 *  samples is underdetermined — the SVD returns a minimum-norm solution that
 *  LOOKS plausible while steering garbage. Shared threshold: the extrinsic
 *  wizard gates its FIN step on the same constant. */
export const MIN_EXTRINSIC_SAMPLES = 10;

/** NAMED error for an underdetermined extrinsic fit — consumers' banners can
 *  match on `name` and the message is actionable as-is. */
export class ExtrinsicFitError extends Error {
  override readonly name = "ExtrinsicFitError";
}

// Exported for calibrate-extrinsic's session (§7.1 S1b) — its FIN wizard
// step fits a live preview regression from the *in-progress* (not yet
// persisted) dataset, same math as loading a saved one.
export async function fitExtrinsicRegression(
  ds: ExtrinsicDataset,
): Promise<ConversionInputs["LE"]> {
  if (!Array.isArray(ds) || ds.length === 0)
    throw new Error("No extrinsic data for regression");
  if (ds.length < MIN_EXTRINSIC_SAMPLES)
    throw new ExtrinsicFitError(
      `extrinsic dataset has ${ds.length} pose${ds.length === 1 ? "" : "s"}; ` +
        `>= ${MIN_EXTRINSIC_SAMPLES} required for the cubic fit`,
    );
  const keys: (keyof Point2d)[] = ["x", "y"];
  const A: Point2d[] = [];
  const V: Point2d[] = [];
  for (const d of ds) {
    A.push(d.angle);
    V.push(d.voltage);
  }
  const config: RegressionConfig = { ply: [3, 2, 1, 0], log: [], exp: [] };
  const V2A = new Regression<Point2d, Point2d>(keys, keys, config);
  const A2V = new Regression<Point2d, Point2d>(keys, keys, config);
  // `magnification`/`magnification_std` = the measured fovea↔wide optical ratio
  // (ruled 2026-07-09: the distance-and-size-free marker-quad ratio, replacing
  // the retired `scale·1000/focal` formula). `scale`/`scale_std` stay for
  // diagnostics/continuity but no longer feed the magnification.
  const { A2H, scale, scale_std, magnification, magnification_std } =
    await findPinholeProjection(ds);
  return {
    V2A: V2A.fit(V, A),
    A2V: A2V.fit(A, V),
    A2H,
    scale,
    scale_std,
    magnification,
    magnification_std,
  };
}

/**
 * Resolve a camera's active extrinsic dataset under the calibration-records-v2
 * model: the LATEST record (by `created`) associated with this camera's key
 * (`resolveActiveDataset`). Falls back to the legacy flat doc
 * (`["calibrate-extrinsic", <cameraKey>]`) when no record is bound — the safety
 * net for an un-migrated dev store (the store-migration framework normally moves
 * every legacy doc into a record at main boot). Reading all records per load is
 * cheap (a rig holds a handful).
 */
async function loadExtrinsicDataset(camera: Camera): Promise<ExtrinsicDataset> {
  const cameraKey = getCameraKey(camera);
  const ids = (await list(EXTRINSIC_STORE)).filter(isRecordId);
  const records = await Promise.all(
    ids.map((id) => read<CalibrationRecord | null>([EXTRINSIC_STORE, id], null)),
  );
  const valid = records.filter(
    (r): r is CalibrationRecord => !!r && !!(r as CalibrationRecord).inner,
  );
  const ds = resolveActiveDataset(valid, cameraKey);
  if (ds && ds.length) return ds;
  return read<ExtrinsicDataset>(["calibrate-extrinsic", cameraKey], []);
}

async function loadExtrinsic(
  camera: Camera,
): Promise<ConversionInputs["LE"]> {
  return fitExtrinsicRegression(await loadExtrinsicDataset(camera));
}

// Exported for calibrate-drift's session (§7.1 S1b) — it reads/writes
// `drift_l`/`drift_r` on this same document directly (via store-hub, for the
// caching/broadcast behavior), so it needs the path without re-deriving the
// hash independently.
export async function tripleConfigPath(L: Camera, C: Camera, R: Camera): Promise<string[]> {
  const key = await stableHash(
    JSON.stringify({
      L: getCameraKey(L),
      C: getCameraKey(C),
      R: getCameraKey(R),
    }),
  );
  return ["triples", key];
}

async function loadConfig(
  L: Camera,
  C: Camera,
  R: Camera,
): Promise<ConversionInputs["config"]> {
  return read<ConversionInputs["config"]>(await tripleConfigPath(L, C, R), {});
}

/**
 * Load the calibration + conversions for an already-open L/C/R triple (e.g. one
 * leased from the camera registry). Separated from camera ownership so callers
 * that already hold the handles don't re-enumerate/re-open them.
 */
export async function loadConversions(
  L: Camera,
  C: Camera,
  R: Camera,
): Promise<ConversionInputs> {
  const [CI, LE, RE, config] = await timeSpan("calibration.loadConversions", () =>
    Promise.all([loadIntrinsic(C), loadExtrinsic(L), loadExtrinsic(R), loadConfig(L, C, R)]),
  );
  return { CI, LE, RE, config };
}

export type CalibratedTriple = {
  leases: Record<Role, CameraLease>;
  conv: CoordinateConversions;
  undistort: Undistort | null;
  /** Calibration-MEASURED fovea↔wide magnification per eye (the ruled
   *  marker-quad ratio from the extrinsic fit — `fitMagnification`), or null
   *  when the extrinsic dataset doesn't support the measurement (legacy fit
   *  with no wide-camera marker quads). Consumers needing a single optical
   *  zoom (e.g. disparity-scope's template match) use this in Auto (zoom 0)
   *  and fall back to their nominal UI zoom on null. */
  magnification: { L: number | null; R: number | null };
  /** The per-triple zoom override (>0), else null — the rig's stored optical
   *  fovea↔wide zoom. Feeds disparity-scope's match magnification under the
   *  ruled order knob > override > measured > 1 (see
   *  `vergence.matchMagnification`); null = no override stored. */
  zoomOverride: number | null;
  /** The per-triple baseline (mm, >0), else null — resolved against the legacy
   *  app-level value + a 200 default by `@lib/calibration-data`'s
   *  `resolveBaseline` at the consumer. */
  baselineMm: number | null;
  /** The per-triple trigger SETTLE hold (µs, v2.0) — 0 when unset (no hold).
   *  The multi-fovea session seeds its live `settle_time_us` state from this at
   *  activation and pushes it into every CMD_FRAME (the drawer overrides live).
   *  Unlike `zoomOverride`/`baselineMm`, 0 is a MEANINGFUL value (no hold), so
   *  it resolves to a number, not null. */
  settleTimeUs: number;
  /** The per-triple tracking-chain DELAY COMPENSATION (ms, SIGNED; 0 = off).
   *  Disparity-scope reads this at activation and chains an IMM motion
   *  predictor after the tracker (imm-delay-compensation.md). Like
   *  `settleTimeUs` it resolves to a number (0 is meaningful = off), but here
   *  the value is SIGNED (a positive value leads, negative lags). */
  delayCompensationMs: number;
  /** The triple config's store path (`["triples", <hash>]`) — for sessions
   *  that read/write it directly beyond what `conv` bakes in (e.g.
   *  calibrate-drift's `drift_l`/`drift_r`). */
  configPath: string[];
};

/**
 * Lease the calibrated L/C/R triple through the registry (bounded retry —
 * RT1) and load its conversions, in the shape every camera-owning control
 * loop needs. Shared by `tracking-single` and `manual-control` sessions so
 * this ~15-line dance (and its RT1 retry behavior) lives in exactly one
 * place. Returns null if no complete triple could be leased within the
 * retry window — caller is responsible for publishing `ready: false`.
 */
export async function leaseCalibratedTriple(): Promise<CalibratedTriple | null> {
  const leases = await timeSpan("calibration.matchTriple", () => retryUntil(matchTriple));
  if (!leases) return null;
  // Release-on-throw (calibration-review-2026-07-11 #2): anything after the
  // acquire can throw — and a fresh/uncalibrated rig ALWAYS throws in
  // `loadConversions` (no extrinsic data). Without the unwind all three leases
  // leaked until force-release/restart, wedging every camera-owning module.
  // The throw still propagates (the caller's `s.fail` keeps its error surface).
  try {
    const inputs = await loadConversions(leases.L.camera, leases.C.camera, leases.R.camera);
    const configPath = await tripleConfigPath(leases.L.camera, leases.C.camera, leases.R.camera);
    // Accept a stored per-triple override/baseline only when it is a finite
    // positive number (0 / NaN / negative ⇒ unset ⇒ null → the consumer falls
    // back per the ruled resolution order).
    const posFinite = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    return {
      leases,
      conv: useCoordinateConversions(inputs),
      undistort: inputs.CI.undistort,
      magnification: {
        L: inputs.LE.magnification ?? null,
        R: inputs.RE.magnification ?? null,
      },
      zoomOverride: posFinite(inputs.config.zoom_override),
      baselineMm: posFinite(inputs.config.baseline_mm),
      // Settle: 0 is meaningful (no hold), so accept any finite >= 0, default 0.
      settleTimeUs:
        typeof inputs.config.settle_time_us === "number" &&
        Number.isFinite(inputs.config.settle_time_us) &&
        inputs.config.settle_time_us >= 0
          ? inputs.config.settle_time_us
          : 0,
      // Delay compensation: SIGNED, 0 = off. Accept any finite number (negative
      // is a valid retrodiction); non-finite / absent ⇒ 0.
      delayCompensationMs:
        typeof inputs.config.delay_compensation_ms === "number" &&
        Number.isFinite(inputs.config.delay_compensation_ms)
          ? inputs.config.delay_compensation_ms
          : 0,
      configPath,
    };
  } catch (e) {
    for (const lease of Object.values(leases)) lease.release();
    throw e;
  }
}

const TRIPLE_UNAVAILABLE =
  "Cameras unavailable — held by another app or not connected";

export async function acquireTriple<C extends Contract>(
  s: ServerSession<C>,
): Promise<CalibratedTriple | null> {
  const triple = await leaseCalibratedTriple();
  if (triple) return triple;
  s.telemetry({ ready: false } as any);
  s.fail(TRIPLE_UNAVAILABLE);
  return null;
}
