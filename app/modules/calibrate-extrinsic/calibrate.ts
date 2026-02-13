// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Point2d } from "core/Geometry";
import { TrackerRecord } from "./tracker.js";
import { ExtrinsicDataset } from "@lib/camera.js";

export type ExtrinsicRecord = {
    L: TrackerRecord & { voltage: Point2d };
    C: TrackerRecord & { angle: Point2d };
    R: TrackerRecord & { voltage: Point2d };
};

export function createDataSet(
    records: ExtrinsicRecord[],
    key: "L" | "R"
): ExtrinsicDataset {
    return records.map((r) => ({
        img_points: r[key].img_pts,
        obj_points: r[key].obj_pts,
        voltage: r[key].voltage,
        angle: r.C.angle,
    }));
}
