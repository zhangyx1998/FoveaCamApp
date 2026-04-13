// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { resolve } from "node:path";
import {
  existsSync,
  statSync,
  accessSync,
  constants as fs_flags,
} from "node:fs";

export function validateWritablePath(path: string): boolean {
  if (path.trim() === "") return false;
  try {
    if (!existsSync(path)) {
      const parent = resolve(path, "..");
      if (parent === path) return false;
      return validateWritablePath(parent);
    }
    const stats = statSync(path);
    if (!stats.isDirectory()) return false;
    accessSync(path, fs_flags.W_OK);
    return true;
  } catch {
    return false;
  }
}
