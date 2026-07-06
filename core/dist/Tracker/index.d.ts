// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { CoreObject } from "../types";
import type { Mat } from "core/Vision";
import type { Rect } from "core/Geometry";

declare module "core/Tracker" {
  export class KCF extends CoreObject<KCF> {
    constructor();
    init(frame: Mat, roi: Rect): void;
    update(frame: Mat): Rect | null;
    updateAsync(frame: Mat): Promise<Rect | null>;
  }
}
