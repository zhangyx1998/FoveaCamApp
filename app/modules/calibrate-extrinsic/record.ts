// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import type { Point } from "core";
import { TrackerRecord } from "./tracker";

export type ExtrinsicRecord = {
    L: TrackerRecord & { pos: Point };
    C: TrackerRecord;
    R: TrackerRecord & { pos: Point };
};
