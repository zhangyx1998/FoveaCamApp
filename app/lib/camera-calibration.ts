// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { computed, toRaw } from "vue";
import { Vision, type Camera, type CameraCalibration } from "core";
import Store from "./store";
import { getCameraKey } from "./camera-store";

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

export async function useIntrinsicCalibration(camera?: Camera) {
    const calibration =
        camera &&
        (await Store.open<CameraCalibration & { date: Date }>(
            "calibrate-intrinsic",
            getCameraKey(camera)
        ));
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
