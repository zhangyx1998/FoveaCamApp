// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { setAction } from "@src/components/Loading.vue";
import { Camera, cleanup, Vision } from "core";
import type { CameraCalibration, Point2d, Point3d } from "core";
import Store from "./store";
import { Mutable } from "./types";
import { computed, markRaw, toRaw } from "vue";
import { Adam, Batch, Model, MSE } from "./regression";

window.addEventListener("beforeunload", cleanup);

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
                "Existing Cameras instance found: " + Cameras.instance.creator
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
    strict: Strict = false as Strict
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
            if (!matched[role])
                throw new Error(`Camera ${ROLE[role]} not found`);
    return markRaw(matched) as MatchedCameras<Strict>;
}

export function describeCamera(camera: Camera | undefined | null) {
    if (!camera) return "Camera Not Connected";
    return `${camera.vendor} ${camera.model} (${camera.serial})`;
}

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
    cal?: Partial<CameraCalibration>
): cal is CameraCalibration {
    return Boolean(
        cal &&
            cal.sensor_size &&
            cal.camera_matrix &&
            cal.dist_coeffs &&
            cal.rvecs &&
            cal.tvecs
    );
}

export async function useIntrinsicCalibration(camera: Camera) {
    setAction("Loading intrinsic calibration data...");
    const calibration = await Store.open<CameraCalibration & { date: Date }>([
        "calibrate-intrinsic",
        getCameraKey(camera),
    ]);
    const undistort = computed(() => {
        try {
            if (validateCalibration(calibration)) {
                const cal = new Vision.Undistort(toRaw(calibration));
                console.log(cal);
                return cal;
            }
        } catch (e) {
            console.warn("Failed to create undistort:", e);
            console.log("Calibration:", toRaw(calibration));
        }
    });
    return { calibration, undistort };
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
    return await Store.open<ExtrinsicDataset>([
        "calibrate-extrinsic",
        getCameraKey(camera),
    ]);
}

class QuadraticRegression2D extends Model<Point2d> {
    predict({ x, y }: Point2d) {
        const [a, b, c, d, e, f] = this;
        return a * x ** 2 + b * y ** 2 + c * x * y + d * x + e * y + f;
    }
    grad({ x, y }: Point2d) {
        // Gradient of (a*x² + b*y² + c*xy + d*x + e*y + f) with respect to [a, b, c, d, e, f]
        return [x ** 2, y ** 2, x * y, x, y, 1];
    }
}

export type Regression = {
    vx: QuadraticRegression2D;
    vy: QuadraticRegression2D;
    rx: QuadraticRegression2D;
    ry: QuadraticRegression2D;
};

function train(batch: Batch<Point2d>) {
    return new QuadraticRegression2D(
        [0, 0, 0, 0, 0, 0],
        MSE,
        0.1,
        new Adam()
    ).train(batch, 1e4);
}

export async function useExtrinsicRegression(ds: Partial<ExtrinsicDataset>) {
    setAction("Performing extrinsic regression...");
    ds = toRaw(ds);
    if (!Array.isArray(ds) || ds.length === 0) {
        console.log(ds);
        throw new Error("No extrinsic data for regression");
    }
    const D = ds.map((d) => ({
        R: d!.angle,
        V: d!.voltage,
    }));
    return {
        vx: await train(
            D.map(({ R, V }) => ({
                input: R,
                output: V.x,
            }))
        ),
        vy: await train(
            D.map(({ R, V }) => ({
                input: R,
                output: V.y,
            }))
        ),
        rx: await train(
            D.map(({ R, V }) => ({
                input: V,
                output: R.x,
            }))
        ),
        ry: await train(
            D.map(({ R, V }) => ({
                input: V,
                output: R.y,
            }))
        ),
    };
}

export type ExtrinsicRegression = Awaited<
    ReturnType<typeof useExtrinsicRegression>
>;
