// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { Mat, Point } from "core";
import { TrackerRecord } from "./tracker";
import { ExtrinsicDataset } from "@lib/camera";

export type ExtrinsicRecord = {
    L: TrackerRecord & { frame: Mat<Uint8Array>; voltage: Point };
    C: TrackerRecord & { frame: Mat<Uint8Array>; angle: Point };
    R: TrackerRecord & { frame: Mat<Uint8Array>; voltage: Point };
};

export function createDataSet(
    records: ExtrinsicRecord[],
    key: "L" | "R"
): ExtrinsicDataset {
    return records.map((r) => ({
        img_points: r[key].img_points,
        obj_points: r[key].obj_points,
        voltage: r[key].voltage,
        angle: r.C.angle,
    }));
}
