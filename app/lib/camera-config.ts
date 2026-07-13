// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure camera helpers shared by the renderer (`@lib/camera`) and the
// orchestrator (camera-owning sessions). Dependency-free (only a `Camera`
// *type* import) so it loads in any process — no Vue, Store, or DOM.

import type { Camera } from "core/Aravis";
import type { Point2d, Point3d } from "core/Geometry";

export const ROLE = {
  L: "Left Fovea",
  C: "Center Wide",
  R: "Right Fovea",
};

// L/C/R role colors. This is the source of truth for JS consumers; it stays a
// plain constant (no CSS-var read) because it also loads in the DOM-less
// orchestrator process. The CSS tokens `--role-l/-c/-r` in `src/tokens.css`
// MIRROR these values — keep the two in lockstep.
export const THEME = {
  L: "cyan",
  C: "orange",
  R: "greenyellow",
};

export type Triple<TL = any, TC = TL, TR = TL> = {
  L: TL;
  C: TC;
  R: TR;
};

export type Role = keyof Triple;

export type Range = { min: number; max: number };
export type AutoMode = "Off" | "Once" | "Continuous";

// ---- Tunable camera controls (A-P11) --------------------------------------
// One declarative schema for the frame-rate / exposure / gain / black-level
// family, which otherwise repeats across the manage-cameras wire type
// (`CameraView`), the 1 Hz read snapshot, the reset defaults, and the UI.
// Every consumer derives its per-control fields from here so the family can't
// drift (a bug class: a new sub-field wired into three of four places).
//
// Field-key names ARE the native `Camera` getter/setter keys AND the
// `CameraView` field names — one identifier, no mapping table. Fields absent
// on a control (frame rate has an enable toggle, not an auto mode; only black
// level has both an availability probe and an auto probe) are simply omitted.

export interface CameraControl {
  /** Value getter/setter key (also the `CameraView` value field). */
  key: string;
  label: string;
  units: string;
  /** Field gating whether the control is exposed (its fieldset `v-if`). */
  availableKey: string;
  /** `{min,max}` range field. */
  rangeKey: string;
  /** Auto-mode field (exposure/gain/black level); omitted for frame rate. */
  autoKey?: string;
  /** Extra gate for the auto mode (black level only). */
  autoAvailableKey?: string;
  /** Manual-enable toggle (frame rate only — it has no auto mode). */
  enableKey?: string;
  /** Formats the raw value for the readout — schema-owned so every consumer
   *  renders it identically. */
  format: (v: number) => string;
}

export const CAMERA_CONTROLS: readonly CameraControl[] = [
  {
    key: "frame_rate",
    label: "Frame Rate",
    units: "FPS",
    availableKey: "frame_rate_available",
    rangeKey: "frame_rate_range",
    enableKey: "frame_rate_enable",
    format: (v) => `${v.toFixed(2)} FPS`,
  },
  {
    key: "exposure",
    label: "Exposure",
    units: "ms",
    availableKey: "exposure_auto_available",
    rangeKey: "exposure_range",
    autoKey: "exposure_auto",
    format: (v) => `${(v / 1000).toFixed(2)} ms`,
  },
  {
    key: "gain",
    label: "Gain",
    units: "dB",
    availableKey: "gain_auto_available",
    rangeKey: "gain_range",
    autoKey: "gain_auto",
    format: (v) => `${v.toFixed(2)} dB`,
  },
  {
    key: "black_level",
    label: "Black Level",
    units: "dB",
    availableKey: "black_level_available",
    rangeKey: "black_level_range",
    autoKey: "black_level_auto",
    autoAvailableKey: "black_level_auto_available",
    format: (v) => `${v.toFixed(2)} dB`,
  },
];

/** The control-family half of `CameraView` — kept here (the pure, both-process
 *  home) so `readControlFields` produces exactly it; the manage-cameras contract
 *  keeps its own flat `CameraView` (a `type` literal, for `Serializable`) with a
 *  compile-time drift guard against this. A `type` (not `interface`) so it gets
 *  an implicit index signature where callers need one. */
export type CameraControlsView = {
  frame_rate_available: boolean;
  frame_rate_enable: boolean;
  frame_rate: number;
  frame_rate_range: Range;
  exposure_auto_available: boolean;
  exposure_auto: AutoMode;
  exposure: number;
  exposure_range: Range;
  gain_auto_available: boolean;
  gain_auto: AutoMode;
  gain: number;
  gain_range: Range;
  black_level_available: boolean;
  black_level_auto_available: boolean;
  black_level_auto: AutoMode;
  black_level: number;
  black_level_range: Range;
}

const ZERO_RANGE: Range = { min: 0, max: 0 };

// ---- Fovea-pair linked config (P5) -----------------------------------------
// When two cameras hold roles L and R, manage-cameras edits them as ONE
// "Fovea Pair" group. Pair values persist into BOTH cameras' existing config
// docs (no new store doc — calibration and every other config reader keep
// working unchanged).

/** Controls the pair edits as one panel: everything EXCEPT frame rate —
 *  per-camera `frame_rate` is meaningless for the hardware-triggered foveas
 *  (the trigger cadence derives from exposure; see `pairTriggerBudget`). */
export const PAIR_LINKED_CONTROLS: readonly CameraControl[] =
  CAMERA_CONTROLS.filter((c) => c.key !== "frame_rate");

/** Value-compare tolerance as a fraction of the control's range span (cameras
 *  quantize writes, so exact equality would flag matched pairs as divergent). */
export const PAIR_EPS_SPAN = 0.005;

/** The pair-comparable half of a camera snapshot (structurally satisfied by
 *  the manage-cameras wire `CameraView`). */
export type PairSideView = CameraControlsView & { pixel_format: string };

/**
 * Divergent pair-linked keys between the L and R snapshots — non-empty gates
 * the pair panel behind the explicit unify prompt (never silently overwrite
 * either side). Rules:
 * - `pixel_format` and each auto mode compare exactly;
 * - a control's VALUE counts only when both sides hold it manually (`Off`) —
 *   under an auto mode the camera meters it live, which is not a config
 *   divergence — and only past `PAIR_EPS_SPAN` of the range span;
 * - controls unavailable on either side are skipped (nothing to link).
 */
export function pairDivergence(left: PairSideView, right: PairSideView): string[] {
  const l = left as Record<string, any>;
  const r = right as Record<string, any>;
  const diffs: string[] = [];
  if (left.pixel_format !== right.pixel_format) diffs.push("pixel_format");
  for (const ctrl of PAIR_LINKED_CONTROLS) {
    if (!l[ctrl.availableKey] || !r[ctrl.availableKey]) continue;
    if (ctrl.autoKey && l[ctrl.autoKey] !== r[ctrl.autoKey]) {
      diffs.push(ctrl.autoKey);
      continue;
    }
    if (ctrl.autoKey && l[ctrl.autoKey] !== "Off") continue;
    const spanOf = (range?: Range) => (range ? range.max - range.min : 0);
    const span = Math.max(spanOf(l[ctrl.rangeKey]), spanOf(r[ctrl.rangeKey]));
    if (Math.abs(l[ctrl.key] - r[ctrl.key]) > span * PAIR_EPS_SPAN)
      diffs.push(ctrl.key);
  }
  return diffs;
}

// ---- Fovea-pair trigger budget (P6) ----------------------------------------
//
// AUTHORITY (ruled default): the cameras' EXPOSURE CONFIG is authoritative and
// the trigger pulse DERIVES from it — `pulseUs` covers the slower eye's
// exposure. FLIP POINT: to make the trigger width authoritative instead,
// invert exactly this function (take `pulseUs` as the input and return the
// exposure to program into both cameras); every consumer (multi-fovea's
// budget derivation, manage-cameras' pair readout) reaches the budget only
// through here, so the flip stays a one-function change.

/** Fixed per-frame overhead margin (µs). A stated MARGIN, not a measured
 *  number: it stands in for trigger dispatch latency plus whatever readout/
 *  transfer tail the camera does not report (the only queryable readout bound
 *  is `frame_rate_range.max`, folded in separately below). */
export const TRIGGER_FRAME_MARGIN_US = 500;

export type PairTriggerBudgetInput = {
  exposureUsL: number;
  exposureUsR: number;
  /** Trigger settle hold (µs), budgeted on EVERY frame — worst case, since the
   *  round-robin switches streams (mirror moves) on nearly every frame. */
  settleUs?: number;
  /** Camera-reported max acquisition rate (Hz) at the current config
   *  (`frame_rate_range.max`) — the only readout/transfer bound the camera
   *  exposes. Absent/0 → the fixed margin alone stands in for readout. */
  maxRateHzL?: number;
  maxRateHzR?: number;
};

export type PairTriggerBudget = {
  /** CMD_FRAME trigger pulse width (µs), matching the wire (`FrameArg.pulse` is
   *  microseconds): covers max(exposureL, exposureR). */
  pulseUs: number;
  /** Floor between CMD_FRAMEs to one L+R pair (ms): settle + the slower
   *  camera's frame floor (max of exposure and its reported readout period,
   *  which overlap on-sensor — never their sum) + `TRIGGER_FRAME_MARGIN_US`. */
  minIntervalMs: number;
  /** 1000 / `minIntervalMs` — the achievable trigger rate. */
  maxRateHz: number;
};

export function pairTriggerBudget(input: PairTriggerBudgetInput): PairTriggerBudget {
  const pos = (v: number | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const cameraFloorUs = (exposureUs: number, maxRateHz: number | undefined) =>
    Math.max(exposureUs, pos(maxRateHz) > 0 ? 1e6 / pos(maxRateHz) : 0);
  const exposureUs = Math.max(pos(input.exposureUsL), pos(input.exposureUsR));
  const frameUs = Math.max(
    cameraFloorUs(pos(input.exposureUsL), input.maxRateHzL),
    cameraFloorUs(pos(input.exposureUsR), input.maxRateHzR),
  );
  const intervalUs = pos(input.settleUs) + frameUs + TRIGGER_FRAME_MARGIN_US;
  return {
    pulseUs: Math.round(exposureUs),
    minIntervalMs: intervalUs / 1000,
    maxRateHz: 1e6 / intervalUs,
  };
}

/**
 * Read every control's snapshot fields off a live camera through the caller's
 * throw-guard (`safe`), preserving the exact per-field fallbacks the 1 Hz poll
 * relies on: a camera can be force-released mid-poll (§12.1 C2), and an
 * unguarded read on a released `CoreObject` throws — uncaught in `setInterval`
 * it would crash the orchestrator. The reader is injected so this stays pure
 * (no `core` import) and unit-testable with a fake camera.
 */
export function readControlFields(
  camera: Record<string, any>,
  safe: <T>(get: () => T, fallback: T) => T,
): CameraControlsView {
  const out: Record<string, unknown> = {};
  for (const ctrl of CAMERA_CONTROLS)
    Object.assign(out, readControlGroup(ctrl, camera, safe));
  return out as unknown as CameraControlsView;
}

function readControlGroup(
  ctrl: CameraControl,
  camera: Record<string, any>,
  safe: <T>(get: () => T, fallback: T) => T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out[ctrl.key] = safe(() => camera[ctrl.key] as number, 0);
  out[ctrl.rangeKey] = safe(() => camera[ctrl.rangeKey] as Range, ZERO_RANGE);
  out[ctrl.availableKey] = safe(() => camera[ctrl.availableKey] as boolean, false);
  if (ctrl.autoKey) out[ctrl.autoKey] = safe(() => camera[ctrl.autoKey!] as AutoMode, "Off");
  if (ctrl.autoAvailableKey)
    out[ctrl.autoAvailableKey] = safe(() => camera[ctrl.autoAvailableKey!] as boolean, false);
  if (ctrl.enableKey) out[ctrl.enableKey] = safe(() => camera[ctrl.enableKey!] as boolean, false);
  return out;
}

/**
 * Targeted read-back after a single-control write: re-read ONLY the field
 * family of the control that owns `key` (any of its value/range/auto/enable/
 * availability keys), so the achieved value and related readouts refresh
 * without a full every-camera snapshot. Same injected-`safe` guard semantics
 * as `readControlFields`. Returns `undefined` for keys outside the schema —
 * the caller falls back to a full snapshot.
 */
export function readControlPatch(
  camera: Record<string, any>,
  key: string,
  safe: <T>(get: () => T, fallback: T) => T,
): Partial<CameraControlsView> | undefined {
  const ctrl = CAMERA_CONTROLS.find(
    (c) =>
      key === c.key ||
      key === c.rangeKey ||
      key === c.availableKey ||
      key === c.autoKey ||
      key === c.autoAvailableKey ||
      key === c.enableKey,
  );
  return ctrl && (readControlGroup(ctrl, camera, safe) as Partial<CameraControlsView>);
}

export function describeCamera(camera: Camera | Empty) {
  if (!camera) return "Camera Not Connected";
  return `${camera.vendor} ${camera.model} (${camera.serial})`;
}

export type CameraDescription = ReturnType<typeof describeCamera>;

function normalizePathSegment(segment: string) {
  return segment.trim().replace(/\s+/g, "-");
}

/** Only needs the identity fields — accepts a live `Camera` or a plain
 *  `{vendor, model, serial}` descriptor (e.g. `CameraInfo`), so callers can
 *  derive a config path without opening the camera. */
export function getCameraKey(camera: Pick<Camera, "vendor" | "model" | "serial">) {
  return [camera.vendor, camera.model, camera.serial]
    .map(normalizePathSegment)
    .join("_");
}

export function getCameraInfo(camera?: Camera) {
  const { frame_rate = NaN, exposure = NaN, gain = NaN } = camera ?? {};
  return {
    Vendor: camera?.vendor ?? "Unknown",
    Camera: camera?.model ?? "Unknown",
    Serial: camera?.serial ?? "Unknown",
    FrameRate: `${frame_rate?.toFixed(2) ?? 0} FPS`,
    Exposure: `${(exposure / 1000)?.toFixed(2) ?? 0} ms`,
    Gain: `${gain?.toFixed(2) ?? 0} dB`,
  };
}

// Per-fovea extrinsic calibration sample (moved here from the now-retired
// `lib/camera.ts` — docs/history/refactor/orchestrator.md §7.1 S1c — since both
// `orchestrator/calibration.ts` and `modules/calibrate-extrinsic/session.ts`
// need the type and this file is the dependency-free, both-processes home
// for pure camera types).
export type ExtrinsicData = {
  /** Outer + internal marker corners. */
  img_points: Point2d[];
  /** 3D positions of corresponding `img_points`. */
  obj_points: Point3d[];
  /** Absolute voltage reading (x, y) in volts. */
  voltage: Point2d;
  /** Angular position (x, y) from the wide camera, in radians. */
  angle: Point2d;
  /** MEASURED-magnification inputs (ruled 2026-07-09). All optional — absent
   *  on legacy datasets, which then carry NO measured magnification. See
   *  `recordMagnification`/`fitMagnification` (@lib/coordinate-conversions). */
  /** Ruling 3 (preferred): the WIDE (C) camera's outer quad of the SAME side
   *  marker this eye's fovea tracks (`C.side_pts[key]` at capture). */
  wide_img_points?: Point2d[];
  /** Ruling 2 (fallback): the wide camera's own CENTER-marker outer quad
   *  (`C.img_pts.slice(0, 4)` at capture). */
  wide_center_points?: Point2d[];
  /** Ruling 2: marker sizes (mm) at capture — center is sized independently. */
  marker?: { side_mm: number; center_mm: number };
};

export type ExtrinsicDataset = ExtrinsicData[];

export function initCamera(camera: Camera, config: Partial<Camera>) {
  // Pixel format must be applied before acquisition starts (it changes the
  // stream payload size), so restore it first.
  if (config.pixel_format !== undefined) {
    try {
      camera.pixel_format = config.pixel_format;
    } catch (e) {
      console.warn("Failed to restore pixel format:", config.pixel_format, e);
    }
  }
  if (config.frame_rate_enable !== undefined)
    camera.frame_rate_enable = config.frame_rate_enable;
  if (!camera.frame_rate_enable && config.frame_rate !== undefined)
    camera.frame_rate = config.frame_rate;
  if (config.exposure_auto !== undefined)
    camera.exposure_auto = config.exposure_auto;
  if (camera.exposure_auto === "Off" && config.exposure !== undefined)
    camera.exposure = config.exposure;
  if (config.gain_auto !== undefined) camera.gain_auto = config.gain_auto;
  if (camera.gain_auto === "Off" && config.gain !== undefined)
    camera.gain = config.gain;
  return camera;
}
