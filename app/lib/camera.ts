// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { markRaw, shallowRef, toRaw, watch } from "vue";
import { setAction } from "@src/components/Loading.vue";
import { Camera } from "core/Aravis";
import { CameraCalibration, Undistort } from "core/Vision";
import type { Point2d, Point3d } from "core/Geometry";
import Regression, { RegressionConfig } from "core/Regression";
import Store from "./store.js";
import { Mutable } from "./types.js";
import { sha256 } from "./util/hash.js";

export const ROLE = {
  L: "Left Fovea",
  C: "Center Wide",
  R: "Right Fovea",
};

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

export class Cameras extends Map<string, Camera> {
  private static instance: Cameras | null = null;
  readonly creator: string;
  constructor(cameras: Array<Camera>) {
    if (Cameras.instance)
      throw new Error(
        "Existing Cameras instance found: " + Cameras.instance.creator,
      );
    super(cameras.map((cam) => [cam.serial, cam]));
    this.creator = new Error().stack || "unknown";
    (window as any).cameras = this;
  }
  public release() {
    for (const cam of this.values()) cam.release();
    this.clear();
    Cameras.instance = null;
  }
}

export default async function useCameras() {
  setAction("Scanning for cameras...");
  return new Cameras(await Camera.list());
}

export type MatchedCameras<Strict = false> = (Strict extends true
  ? Triple<Camera>
  : Partial<Triple<Camera>>) & {
  release(): void;
};

export async function useMatchedCameras<Strict extends true | false = false>(
  strict: Strict = false as Strict,
): Promise<MatchedCameras<Strict>> {
  const cams = await useCameras();
  const matched: MatchedCameras = {
    release() {
      cams.release();
    },
  };
  for (const cam of cams.values()) {
    const store = await useCameraConfig(cam);
    switch (store.role) {
      case "L":
        matched.L ??= initCamera(cam, store);
        break;
      case "C":
        matched.C ??= initCamera(cam, store);
        break;
      case "R":
        matched.R ??= initCamera(cam, store);
        break;
    }
  }
  if (strict)
    for (const role of Object.keys(ROLE) as Array<keyof Triple>)
      if (!matched[role]) throw new Error(`Camera ${ROLE[role]} not found`);
  return markRaw(matched) as MatchedCameras<Strict>;
}

export function describeCamera(camera: Camera | undefined | null) {
  if (!camera) return "Camera Not Connected";
  return `${camera.vendor} ${camera.model} (${camera.serial})`;
}

export type CameraDescription = ReturnType<typeof describeCamera>;

function normalizePathSegment(segment: string) {
  return segment.trim().replace(/\s+/g, "-");
}

export function getCameraKey(camera: Camera) {
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

export function useCameraConfig(camera: Camera) {
  const key = getCameraKey(camera);
  return Store.open<Mutable<Camera> & { role?: keyof Triple }>([
    "cameras",
    key,
  ]);
}

export type CameraConfig = Awaited<ReturnType<typeof useCameraConfig>>;

export function initCamera(camera: Camera, config: Partial<Camera>) {
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

function validateCalibration(
  cal?: Partial<CameraCalibration>,
): cal is CameraCalibration {
  return Boolean(
    cal &&
    cal.sensor_size &&
    cal.camera_matrix &&
    cal.dist_coeffs &&
    cal.rvecs &&
    cal.tvecs,
  );
}

export async function useIntrinsicCalibration(camera: Camera) {
  setAction("Loading intrinsic calibration data...");
  const calibration = await Store.open<CameraCalibration>([
    "calibrate-intrinsic",
    getCameraKey(camera),
  ]);
  let u = shallowRef<Undistort | null>(null);
  function undistort() {
    const cal = toRaw(calibration);
    try {
      if (validateCalibration(cal)) u.value = new Undistort(cal);
    } catch (e) {
      console.warn("Failed to create undistort:", e);
      console.log("Calibration:", cal);
    }
  }
  watch(calibration, undistort, { immediate: true });
  return {
    calibration,
    get undistort() {
      return u.value;
    },
  };
}

export type IntrinsicCalibration = Awaited<
  ReturnType<typeof useIntrinsicCalibration>
>;

// Data stored in application storage for each fovea camera.
export type ExtrinsicData = {
  // Outer + internal corners
  img_points: Point2d[];
  // 3D positions of corresponding img_pts
  obj_points: Point3d[];
  // Absolute voltage reading (x, y)
  voltage: Point2d;
  // Angular position (x, y) from wide camera
  angle: Point2d;
};

export type ExtrinsicDataset = ExtrinsicData[];

export async function useExtrinsicCalibration(camera: Camera) {
  setAction("Loading extrinsic calibration data...");
  return await Store.open<ExtrinsicDataset>(
    ["calibrate-extrinsic", getCameraKey(camera)],
    [],
  );
}

export async function useExtrinsicRegression(ds: Partial<ExtrinsicDataset>) {
  setAction("Performing extrinsic regression...");
  ds = toRaw(ds);
  if (!Array.isArray(ds) || ds.length === 0) {
    console.log(ds);
    throw new Error("No extrinsic data for regression");
  }
  const keys: (keyof Point2d)[] = ["x", "y"];
  const A: Point2d[] = [];
  const V: Point2d[] = [];
  for (const d of ds) {
    A.push(d!.angle);
    V.push(d!.voltage);
  }
  console.log({ V, A });
  const config: RegressionConfig = {
    ply: [2, 1, 0],
    log: [],
    exp: [],
  };
  const V2A = new Regression<Point2d, Point2d>(keys, keys, config);
  const A2V = new Regression<Point2d, Point2d>(keys, keys, config);
  console.log("Extrinsic regression result:", { V2A, A2V });
  return { V2A: V2A.fit(V, A), A2V: A2V.fit(A, V) };
}

export type ExtrinsicRegression = Awaited<
  ReturnType<typeof useExtrinsicRegression>
>;

async function hashTriple({ L, C, R }: Triple<Camera>) {
  return await sha256(
    JSON.stringify({
      L: getCameraKey(L),
      C: getCameraKey(C),
      R: getCameraKey(R),
    }),
  );
}

export type TripleConfig = Triple<CameraDescription> & {
  zoom_factor: number;
  baseline_mm: number;
  drift_l: Point2d; // Angular drift in radians
  drift_r: Point2d; // Angular drift in radians
};

export async function useTripleConfig(triple: Triple<Camera>) {
  const key = await hashTriple(triple);
  const config = await Store.open<TripleConfig>(["triples", key]);
  config.L ??= describeCamera(triple.L);
  config.C ??= describeCamera(triple.C);
  config.R ??= describeCamera(triple.R);
  return config;
}

export async function useCalibratedTriple() {
  const { L, C, R, ...forward } = await useMatchedCameras(true);
  const [CI, LE, RE, config] = await Promise.all([
    useIntrinsicCalibration(C),
    useExtrinsicCalibration(L).then(useExtrinsicRegression),
    useExtrinsicCalibration(R).then(useExtrinsicRegression),
    useTripleConfig({ L, C, R }),
  ]);
  return {
    /* Left Foveated Camera */
    L,
    /* Center Wide Camera */
    C,
    /* Right Foveated Camera */
    R,
    /** Center Fovea Intrinsic Calibration */
    CI,
    /** Left Fovea Extrinsic Regression */
    LE,
    /** Right Fovea Extrinsic Regression */
    RE,
    /* Triple Config */
    config,
    /* Forward Additional Properties */
    ...forward,
  };
}

export type CalibratedTriple = Awaited<ReturnType<typeof useCalibratedTriple>>;

export function useCoordinateConversions({
  LE,
  CI,
  RE,
  config,
}: CalibratedTriple) {
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
      C(px: Point2d) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.position([px], true)[0];
      },
    },
    /** Conversion from pixel (px) to angle (rad) */
    P2A: {
      C(px: Point2d) {
        if (!CI.undistort) throw new Error("Wide camera not calibrated");
        return CI.undistort.angular([px], false)[0];
      },
    },
  };
}

export type CoordinateConversions = ReturnType<typeof useCoordinateConversions>;

export async function getFrameSize(camera: Camera) {
  const frame = await camera.grab();
  const { width, height } = frame;
  frame.release();
  return { width, height };
}
