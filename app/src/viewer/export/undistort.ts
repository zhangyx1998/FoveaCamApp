// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// UNDISTORT remap-map generation for the viewer video export (viewer-export.md
// spec 4). The viewer cannot use core (the no-core exception is decode only), so
// undistortion is computed as PURE TS math from the recording's embedded camera
// matrix + distortion coefficients (the `fovea:wide-camera` metadata singleton,
// multi-fovea-recording ruling 2 — only the WIDE/center stream carries it; fovea
// streams have per-frame dynamic maps and get the disabled-with-hint path).
//
// The maps are the standard OpenCV `initUndistortRectifyMap` (identity
// rectification, same K as the new camera matrix): for each DEST pixel we apply
// the Brown-Conrady FORWARD distortion model to find the SOURCE pixel to sample.
// ffmpeg's `remap` filter then samples the recorded (distorted) frame through
// two 16-bit PGM maps (one X, one Y); out-of-bounds samples are FILLED (→ alpha
// 0 when transparency is on, black otherwise — spec 5).
//
// Node-free (Float32Array + a byte writer); the PGM bytes are a plain Uint8Array
// so this stays unit-testable off Electron.

/** A 3×3 pinhole camera matrix, row-major. */
export type CameraMatrix = readonly [
  readonly [number, number, number],
  readonly [number, number, number],
  readonly [number, number, number],
];

/** Parsed calibration for one stream (from `fovea:wide-camera`). */
export interface Calibration {
  /** fx, fy (focal lengths, px). */
  fx: number;
  fy: number;
  /** cx, cy (principal point, px). */
  cx: number;
  cy: number;
  /** Brown-Conrady coefficients [k1, k2, p1, p2, k3?, ...]. Missing → 0. */
  dist: number[];
}

/** Sentinel map value meaning "out of bounds — fill". Any coordinate ≥ the frame
 *  dimension makes ffmpeg's remap use the fill color; 0xFFFF is safely past any
 *  real sensor width/height and fits a 16-bit PGM sample. */
export const REMAP_FILL = 0xffff;

/** The two remap maps for a frame: `xmap`/`ymap` are the SOURCE pixel to fetch
 *  for each DEST pixel (row-major, length = width·height). Coordinates are
 *  floats (sub-pixel); `toPgm16` clamps/rounds and marks OOB. */
export interface RemapMaps {
  width: number;
  height: number;
  xmap: Float32Array;
  ymap: Float32Array;
}

/** Parse the `fovea:wide-camera` metadata map (string→string, values JSON-
 *  encoded by the recorder) into a `Calibration`, or null when the record is
 *  absent / lacks a usable camera matrix. Production keys (session.ts
 *  `wideCameraMeta`): `camera_matrix` (3×3), `dist_coeffs` (array). Tolerant of
 *  the alternate `matrix`/`distortion` and `cameraMatrix`/`dist` spellings the
 *  writer tests use, so any real container parses. */
export function parseWideCalibration(
  meta: Record<string, string> | null | undefined,
): Calibration | null {
  if (!meta) return null;
  const readJson = (...keys: string[]): unknown => {
    for (const k of keys) {
      const raw = meta[k];
      if (raw == null) continue;
      try {
        return JSON.parse(raw);
      } catch {
        /* not JSON — try next key */
      }
    }
    return undefined;
  };
  const m = readJson("camera_matrix", "cameraMatrix", "matrix");
  if (!Array.isArray(m) || m.length < 3) return null;
  const row = (i: number): number[] => (Array.isArray(m[i]) ? (m[i] as number[]) : []);
  const fx = Number(row(0)[0]);
  const fy = Number(row(1)[1]);
  const cx = Number(row(0)[2]);
  const cy = Number(row(1)[2]);
  if (![fx, fy, cx, cy].every((v) => Number.isFinite(v)) || fx === 0 || fy === 0)
    return null;
  const distRaw = readJson("dist_coeffs", "dist", "distortion");
  const dist = Array.isArray(distRaw) ? distRaw.map(Number).map((v) => (Number.isFinite(v) ? v : 0)) : [];
  return { fx, fy, cx, cy, dist };
}

/** Build the undistort remap maps for a `width`×`height` frame from a
 *  calibration. Identity rectification: dest pixel (u,v) → normalized (x,y) via
 *  the SAME K, forward Brown-Conrady distortion, back to source pixels through
 *  K. A dest pixel whose source lands outside the frame is left at its computed
 *  (out-of-range) coordinate; `toPgm16` marks it as fill. */
export function buildRemapMaps(cal: Calibration, width: number, height: number): RemapMaps {
  const { fx, fy, cx, cy, dist } = cal;
  const k1 = dist[0] ?? 0;
  const k2 = dist[1] ?? 0;
  const p1 = dist[2] ?? 0;
  const p2 = dist[3] ?? 0;
  const k3 = dist[4] ?? 0;
  const xmap = new Float32Array(width * height);
  const ymap = new Float32Array(width * height);
  let i = 0;
  for (let v = 0; v < height; v++) {
    const y = (v - cy) / fy;
    const y2 = y * y;
    for (let u = 0; u < width; u++, i++) {
      const x = (u - cx) / fx;
      const r2 = x * x + y2;
      const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
      // Tangential (Brown-Conrady): p1,p2 shear.
      const xD = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
      const yD = y * radial + p1 * (r2 + 2 * y2) + 2 * p2 * x * y;
      xmap[i] = fx * xD + cx;
      ymap[i] = fy * yD + cy;
    }
  }
  return { width, height, xmap, ymap };
}

/** Encode a single-channel 16-bit PGM (`P5`, maxval 65535, BIG-ENDIAN samples —
 *  the PGM/PNM spec's byte order, which ffmpeg's remap map reader expects). Each
 *  source coordinate is rounded to the nearest integer and clamped to
 *  [0, dim-1]; a coordinate outside the frame is written as `REMAP_FILL` so
 *  remap fills it. `dim` is the frame width for the X map, height for the Y. */
export function toPgm16(
  map: Float32Array,
  width: number,
  height: number,
  dim: number,
): Uint8Array {
  const header = `P5\n${width} ${height}\n65535\n`;
  const headerBytes = new TextEncoder().encode(header);
  const out = new Uint8Array(headerBytes.length + map.length * 2);
  out.set(headerBytes, 0);
  let o = headerBytes.length;
  for (let i = 0; i < map.length; i++) {
    const c = Math.round(map[i]!);
    const val = c < 0 || c >= dim ? REMAP_FILL : c;
    out[o++] = (val >> 8) & 0xff; // big-endian high byte
    out[o++] = val & 0xff;
  }
  return out;
}

/** The X and Y PGM16 blobs for a set of remap maps — the two files ffmpeg's
 *  remap filter consumes. */
export function remapMapsToPgm(maps: RemapMaps): { xPgm: Uint8Array; yPgm: Uint8Array } {
  return {
    xPgm: toPgm16(maps.xmap, maps.width, maps.height, maps.width),
    yPgm: toPgm16(maps.ymap, maps.width, maps.height, maps.height),
  };
}
