// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Small, Vue-free primitives shared by frame-driven fovea/control sessions.
// Keep this as a toolkit, not a session framework: lifecycle and session
// semantics stay in each module until the larger resource-scope redesign lands.

import type { Rect } from "core/Geometry";
import type { Pos } from "@lib/controller-codec";

export const ORIGIN_POS: Pos = { x: 0, y: 0 };
export const VOLT_TELEMETRY_INTERVAL_MS = 33; // ~30 Hz UI readout

export function radians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function depthFromInverse(inv: number): number {
  return inv <= 0 ? Infinity : 1 / (inv * inv);
}

export function clampRectToSize(
  r: Rect,
  size: { width: number; height: number },
): Rect {
  const x = Math.max(0, Math.min(Math.round(r.x), size.width - 1));
  const y = Math.max(0, Math.min(Math.round(r.y), size.height - 1));
  const width = Math.max(1, Math.min(Math.round(r.width), size.width - x));
  const height = Math.max(1, Math.min(Math.round(r.height), size.height - y));
  return { x, y, width, height };
}
