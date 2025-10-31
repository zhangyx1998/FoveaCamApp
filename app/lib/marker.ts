// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import {
    ArUcoDetectResult,
    Point2d,
    Point3d,
    PreDefinedDictionary,
    Size,
    Vision,
} from "core";
import { FunctionalComponent, h } from "vue";

export const CORNER_OBJ_POINTS: Point3d[] = [
    { x: -0.5, y: 0.5, z: 0 },
    { x: 0.5, y: 0.5, z: 0 },
    { x: 0.5, y: -0.5, z: 0 },
    { x: -0.5, y: -0.5, z: 0 },
];

function isCorner(a: number, b: number, c: number, d: number): boolean {
    const count = [a, b, c, d].filter((v) => v !== 0).length;
    if (count === 0 || count === 4) return false;
    if (count === 1 || count === 3) return true;
    // count === 2
    return ![
        [a, b],
        [b, c],
        [c, d],
    ].some(([x, y]) => !!x === !!y);
}

export function getMarkerProjection(result: ArUcoDetectResult) {
    return Vision.Projector.solve(result, CORNER_OBJ_POINTS);
}

export function bilinearInterpolate(
    corners: Point2d[], // 4 corners in order: tl, tr, br, bl
    obj_points: Point2d[] // [-0.5, 0.5]
): Point2d[] {
    const [tl, tr, br, bl] = corners;
    const ret: Point2d[] = [];
    for (const p of obj_points) {
        const x = p.x + 0.5;
        const y = p.y + 0.5;
        const top = {
            x: tl.x * (1 - x) + tr.x * x,
            y: tl.y * (1 - x) + tr.y * x,
        };
        const bottom = {
            x: bl.x * (1 - x) + br.x * x,
            y: bl.y * (1 - x) + br.y * x,
        };
        ret.push({
            x: top.x * (1 - y) + bottom.x * y,
            y: top.y * (1 - y) + bottom.y * y,
        });
    }
    return ret;
}

export function* getInternalObjectPoints(pattern: (0 | 1)[][] & Size) {
    const grid_size: Size = {
        width: 1 / (pattern.width + 2),
        height: 1 / (pattern.height + 2),
    };
    const tl: Point2d = {
        x: (-grid_size.width * pattern.width) / 2,
        y: (-grid_size.height * pattern.height) / 2,
    };
    function at(i: number, j: number) {
        if (i < 0 || i >= pattern.height) return 0;
        if (j < 0 || j >= pattern.width) return 0;
        return pattern[i][j];
    }
    for (let i = 0; i <= pattern.height; i++) {
        for (let j = 0; j <= pattern.width; j++) {
            const corner = isCorner(
                at(i - 1, j - 1),
                at(i - 1, j),
                at(i, j),
                at(i, j - 1)
            );
            if (corner) {
                yield {
                    x: tl.x + grid_size.width * j,
                    y: tl.y + grid_size.height * i,
                    z: 0,
                } as Point3d;
            }
        }
    }
}

const options = [
    "4X4_50",
    "4X4_100",
    "4X4_250",
    "4X4_1000",
    "5X5_50",
    "5X5_100",
    "5X5_250",
    "5X5_1000",
    "6X6_50",
    "6X6_100",
    "6X6_250",
    "6X6_1000",
    "7X7_50",
    "7X7_100",
    "7X7_250",
    "7X7_1000",
    "ARUCO_ORIGINAL",
    "APRILTAG_16h5",
    "APRILTAG_25h9",
    "APRILTAG_36h10",
    "APRILTAG_36h11",
    "ARUCO_MIP_36h12",
] as const;

export const DictionaryTypeSelector: FunctionalComponent<{
    modelValue: PreDefinedDictionary;
}> = (props, ctx) => {
    return h(
        "select",
        ctx.attrs,
        options.map((k) => h("option", { value: k }, k))
    );
};
