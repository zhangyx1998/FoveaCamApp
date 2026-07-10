// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Coordinate conversions for a calibrated fovea triple — angle ⇄ voltage (per
// fovea, drift-corrected), angle ⇄ wide pixel (intrinsic undistort), and
// angle → homography. Pure math over the loaded calibration objects, shared by
// the renderer and the orchestrator control loops.
//
// Inputs are described structurally (`ConversionInputs`) so both the renderer's
// `CalibratedTriple` (`camera.ts`) and the orchestrator's loaded triple
// (`orchestrator/calibration.ts`) satisfy it — neither side is coupled to the
// other's loader types.

import type { Point2d } from "core/Geometry";
import type { Undistort, Mat } from "core/Vision";
import { createMat } from "./mat.js";

/** Minimal regression shape the conversions need (predict only). */
type Predict<O> = { predict(x: Point2d): O };

/** Per-fovea extrinsic regressions. */
export type ExtrinsicConversions = {
  A2V: Predict<Point2d>;
  V2A: Predict<Point2d>;
  A2H: Predict<Mat<Float64Array>>;
  /** Calibration-MEASURED fovea image scale: fovea px per object-unit at the
   *  extrinsic protocol's nominal 1000-object-unit marker distance (from
   *  `findPinholeProjection`, @lib/marker). Optional — absent on fits made
   *  before this field existed. NOTE: no longer feeds the fovea↔wide
   *  magnification (the ×1000/focal formula was RETIRED 2026-07-09 — it baked
   *  in a false "marker at 1000 side-lengths" distance assumption); kept only
   *  because it is persisted on old fits and is a harmless calibration signal. */
  scale?: number;
  /** Per-pose spread of `scale` (same units) — a calibration-quality signal. */
  scale_std?: number;
  /** Calibration-MEASURED fovea↔wide optical magnification (mean over the
   *  records that support it — see {@link fitMagnification}). Optional — null/
   *  undefined when NO record carried the wide camera's view of the marker
   *  (legacy dataset, uncalibrated wide camera). Consumers (disparity-scope's
   *  template match) use this in Auto (zoom 0) and fall back to their nominal
   *  zoom otherwise. */
  magnification?: number | null;
  /** Per-record spread of `magnification` — a calibration-quality signal. */
  magnification_std?: number | null;
};

/** The marker-quad fields a per-record magnification is derived from — a
 *  structural subset of `ExtrinsicData` (@lib/camera-config), declared here so
 *  the pure derivation below stays independent of the dataset/native area. */
export type MagnificationSample = {
  /** The fovea camera's outer marker quad (first 4 of `img_points`). */
  img_points: Point2d[];
  /** Ruling 3 (preferred): the WIDE (C) camera's quad of the SAME side marker
   *  this eye's fovea tracks — same physical marker, so size and distance
   *  cancel exactly in the ratio. */
  wide_img_points?: Point2d[];
  /** Ruling 2 (fallback): the wide camera's own CENTER-marker quad; needs
   *  `marker` sizes because the center marker is sized independently. */
  wide_center_points?: Point2d[];
  /** Ruling 2: marker sizes (mm) at capture — the center is adjusted freely
   *  relative to the sides, so the fallback must carry both. */
  marker?: { side_mm: number; center_mm: number };
};

/**
 * The measured fovea↔wide optical magnification for ONE calibration record —
 * the distance-and-size-free ratio of the two cameras' views of a marker
 * (RULED 2026-07-09; replaces the retired `scale·1000/focal` formula, which
 * assumed the marker sat 1000 side-lengths away — false on the rig).
 *
 *  - Preferred (ruling 3): `sqrt(area(foveaQuad) / area(wide_img_points))` —
 *    the fovea and the wide camera view the SAME physical side marker, so the
 *    marker's size and its distance cancel; the area ratio's square root is
 *    the linear px-per-px magnification directly.
 *  - Fallback (ruling 2): `sqrt(area(foveaQuad) / area(wide_center_points)) ×
 *    (center_mm / side_mm)` — the fovea sees the side marker, the wide camera
 *    sees the (independently-sized) CENTER marker; fovea px/mm =
 *    foveaSidePx/side_mm, wide px/mm = centerPx/center_mm, and the
 *    magnification is their ratio. Needs `marker`; skipped without it.
 *
 * `areaOf` is injected (core's `Geometry.area` is native) so this stays pure
 * and unit-testable with a shoelace area. Returns `null` when neither wide
 * quad is present (record excluded from the fit) or a quad is degenerate.
 */
export function recordMagnification(
  d: MagnificationSample,
  areaOf: (pts: Point2d[]) => number,
): number | null {
  const foveaArea = areaOf(d.img_points.slice(0, 4));
  if (!(foveaArea > 0)) return null;
  if (d.wide_img_points && d.wide_img_points.length >= 4) {
    const wa = areaOf(d.wide_img_points.slice(0, 4));
    if (wa > 0) return Math.sqrt(foveaArea / wa);
  }
  if (d.wide_center_points && d.wide_center_points.length >= 4 && d.marker) {
    const wa = areaOf(d.wide_center_points.slice(0, 4));
    const { side_mm, center_mm } = d.marker;
    if (wa > 0 && side_mm > 0 && center_mm > 0)
      return Math.sqrt(foveaArea / wa) * (center_mm / side_mm);
  }
  return null;
}

/**
 * Fit the fovea↔wide magnification over a whole extrinsic dataset: the MEAN of
 * every record's {@link recordMagnification} (spread as `magnification_std`).
 * Both are `null` when NO record supports a measurement — the consumer then
 * has no measured value and falls back to its nominal zoom.
 */
export function fitMagnification(
  ds: MagnificationSample[],
  areaOf: (pts: Point2d[]) => number,
): { magnification: number | null; magnification_std: number | null } {
  const mags: number[] = [];
  for (const d of ds) {
    const m = recordMagnification(d, areaOf);
    if (m != null && Number.isFinite(m) && m > 0) mags.push(m);
  }
  if (mags.length === 0) return { magnification: null, magnification_std: null };
  const magnification = mags.reduce((a, b) => a + b, 0) / mags.length;
  const magnification_std = Math.sqrt(
    mags.reduce((a, b) => a + (b - magnification) ** 2, 0) / mags.length,
  );
  return { magnification, magnification_std };
}

/** Everything the conversions read from a calibrated triple. */
export interface ConversionInputs {
  LE: ExtrinsicConversions;
  RE: ExtrinsicConversions;
  CI: { undistort: Undistort | null };
  /** The per-triple config doc (`["triples", <hash>]`). `drift_l`/`drift_r`
   *  feed the conversion drift; `zoom_override`/`baseline_mm` are carried
   *  through (loadConfig reads the whole doc) for the disparity-scope session's
   *  match-magnification + verge-limit resolution — they do NOT alter the
   *  conversion math here. */
  config: {
    drift_l?: Point2d;
    drift_r?: Point2d;
    zoom_override?: number;
    baseline_mm?: number;
    /** Per-triple trigger settle hold (µs, v2.0) — carried through for the
     *  multi-fovea session; does NOT alter the conversion math here. */
    settle_time_us?: number;
    /** Per-triple tracking-chain delay compensation (ms, signed) — carried
     *  through for the disparity-scope IMM predictor; does NOT alter the
     *  conversion math here. */
    delay_compensation_ms?: number;
  };
}

export function useCoordinateConversions({
  LE,
  CI,
  RE,
  config,
}: ConversionInputs) {
  /** Apply calibrated drift to target angular position */
  function applyDrift({ x, y }: Point2d, drift?: Partial<Point2d>): Point2d {
    return { x: x + (drift?.x ?? 0), y: y + (drift?.y ?? 0) };
  }
  /** Remove calibrated drift from angular position derived from voltage */
  function removeDrift({ x, y }: Point2d, drift?: Partial<Point2d>): Point2d {
    return { x: x - (drift?.x ?? 0), y: y - (drift?.y ?? 0) };
  }
  return {
    /** Conversion from angle (rad) to voltage (V) */
    A2V: {
      L(angle: Point2d) {
        return LE.A2V.predict(removeDrift(angle, config.drift_l));
      },
      R(angle: Point2d) {
        return RE.A2V.predict(removeDrift(angle, config.drift_r));
      },
    },
    /** Conversion from voltage (V) to angle (rad) */
    V2A: {
      L(volt: Point2d) {
        return applyDrift(LE.V2A.predict(volt), config.drift_l);
      },
      R(volt: Point2d) {
        return applyDrift(RE.V2A.predict(volt), config.drift_r);
      },
    },
    /** Conversion from angle (rad) to pixel (px) */
    A2P: {
      C(px: Point2d, distort = true) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.position([px], distort)[0];
      },
    },
    /** Conversion from pixel (px) to angle (rad) */
    P2A: {
      C(px: Point2d, undistort = true) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.angular([px], undistort)[0];
      },
    },
    /** Conversion from angle (rad) to homography matrix */
    A2H: {
      L(angle: Point2d) {
        const H = createMat(Float64Array, [3, 3]);
        return Object.assign(H, LE.A2H.predict(angle));
      },
      R(angle: Point2d) {
        const H = createMat(Float64Array, [3, 3]);
        return Object.assign(H, RE.A2H.predict(angle));
      },
    },
  };
}

export type CoordinateConversions = ReturnType<typeof useCoordinateConversions>;
