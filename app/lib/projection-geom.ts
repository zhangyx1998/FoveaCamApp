// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure marker-projection geometry, extracted from @lib/marker so CORE-FREE contexts (the
// renderer's calibration visualizer) can share it alongside the core-importing marker.ts
// (which re-exports these + holds the core-backed solves). Plain arithmetic over
// Point2d/Point3d (type-only imports, no core/ at runtime): the single source of truth for
// the pinhole marker model (obj-space corners, bilinear interpolation, relative→absolute
// placement, rotate-and-perspective-project). Do NOT duplicate these — import from here.
// spec: docs/spec/calibration.md#projection-geom

import type { Point2d, Point3d, Size } from "core/Geometry";

/** Object-space corners of a unit marker, in tl, tr, br, bl order. */
export const CORNER_OBJ_POINTS: Point3d[] = [
  { x: -0.5, y: -0.5, z: 0 }, // top-left
  { x: +0.5, y: -0.5, z: 0 }, // top-right
  { x: +0.5, y: +0.5, z: 0 }, // bottom-right
  { x: -0.5, y: +0.5, z: 0 }, // bottom-left
];

export function isCorner(a: number, b: number, c: number, d: number): boolean {
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

export function bilinearInterpolate(
  corners: Iterable<Point2d>, // 4 corners in order: tl, tr, br, bl
  obj_points: Iterable<Point2d>, // [-0.5, 0.5]
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
        at(i, j - 1),
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

export function relativeToAbsolute(
  pts: Point2d[],
  center: Point2d,
  scale: number,
): Point2d[] {
  return pts.map(({ x, y }) => ({
    x: center.x + x * scale,
    y: center.y + y * scale,
  }));
}

export function transformPoints(
  pts: Point2d[],
  rotation: Partial<Point2d> | Empty, // radians
  distance: number = Infinity, // relative to pts units
) {
  if (!rotation) return pts;
  // Apply 3D rotation if provided
  const rx = rotation.x ?? 0;
  const ry = rotation.y ?? 0;
  let project: (p: Point2d) => Point2d;
  if (distance === Infinity) {
    // Rotate in-place if distance is infinite
    // TODO: Fix this
    project = ({ x, y }) => {
      let z = 0;
      // Rotate around X axis
      [y, z] = [
        y * Math.cos(rx) - z * Math.sin(rx),
        y * Math.sin(rx) + z * Math.cos(rx),
      ];
      // Rotate around Y axis
      [x, z] = [
        x * Math.cos(ry) + z * Math.sin(ry),
        -x * Math.sin(ry) + z * Math.cos(ry),
      ];
      return { x, y };
    };
  } else {
    project = ({ x, y }) => {
      let z = distance;
      // Rotate around X axis
      [y, z] = [
        y * Math.cos(rx) - z * Math.sin(rx),
        y * Math.sin(rx) + z * Math.cos(rx),
      ];
      // Rotate around Y axis
      [x, z] = [
        x * Math.cos(ry) + z * Math.sin(ry),
        -x * Math.sin(ry) + z * Math.cos(ry),
      ];
      // Perspective divide
      [x, y] = [(x * distance) / z, (y * distance) / z];
      return { x, y };
    };
  }
  const c = project({ x: 0, y: 0 });
  pts = pts.map((p) => {
    const { x, y } = project(p);
    return {
      x: x - c.x,
      y: y - c.y,
    };
  });
  return pts;
}

/** Shoelace polygon area (absolute) — the PURE replacement for core's native
 *  `Geometry.area`, so the projection math stays core-free. Same magnitude for
 *  the convex marker quads it is used on. */
export function shoelaceArea(pts: readonly Point2d[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}
