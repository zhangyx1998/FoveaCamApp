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
import { sha256 } from "@lib/util/hash";
import {
  useCoordinateConversions,
  type ConversionInputs,
  type CoordinateConversions,
} from "@lib/coordinate-conversions";
import type { ExtrinsicDataset } from "@lib/camera";
import { cameraConfigPath } from "./camera.js";
import { read } from "./store.js";
import { matchTriple, retryUntil, type CameraLease } from "./registry.js";

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

async function loadIntrinsic(
  camera: Camera,
): Promise<{ undistort: Undistort | null }> {
  const cal = await read<Partial<CameraCalibration>>(
    ["calibrate-intrinsic", getCameraKey(camera)],
    {},
  );
  try {
    if (validate(cal)) return { undistort: new Undistort(cal) };
  } catch (e) {
    console.warn("[calibration] failed to build undistort:", e);
  }
  return { undistort: null };
}

async function loadExtrinsic(
  camera: Camera,
): Promise<ConversionInputs["LE"]> {
  const ds = await read<ExtrinsicDataset>(
    ["calibrate-extrinsic", getCameraKey(camera)],
    [],
  );
  if (!Array.isArray(ds) || ds.length === 0)
    throw new Error(`No extrinsic data for ${getCameraKey(camera)}`);
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
  const A2H = await findPinholeProjection(ds);
  return { V2A: V2A.fit(V, A), A2V: A2V.fit(A, V), A2H };
}

async function loadConfig(
  L: Camera,
  C: Camera,
  R: Camera,
): Promise<ConversionInputs["config"]> {
  const key = await sha256(
    JSON.stringify({
      L: getCameraKey(L),
      C: getCameraKey(C),
      R: getCameraKey(R),
    }),
  );
  return read<ConversionInputs["config"]>(["triples", key], {});
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
  const [CI, LE, RE, config] = await Promise.all([
    loadIntrinsic(C),
    loadExtrinsic(L),
    loadExtrinsic(R),
    loadConfig(L, C, R),
  ]);
  return { CI, LE, RE, config };
}

export type CalibratedTriple = {
  leases: Record<Role, CameraLease>;
  conv: CoordinateConversions;
  undistort: Undistort | null;
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
  const leases = await retryUntil(matchTriple);
  if (!leases) return null;
  const inputs = await loadConversions(leases.L.camera, leases.C.camera, leases.R.camera);
  return {
    leases,
    conv: useCoordinateConversions(inputs),
    undistort: inputs.CI.undistort,
  };
}
