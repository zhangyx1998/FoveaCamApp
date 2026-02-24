// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import path from "node:path";
import { app } from "electron";
import { existsSync } from "node:fs";

export function resolveAsset(...segments: string[]) {
  const base = app.isPackaged
    ? // .../FoveaCam.app/Contents/Resources
      process.resourcesPath
    : // Project root (.../app/)
      path.join(process.cwd(), "build");
  return path.join(base, ...segments);
}

export function getIcon(name: string) {
  const path = resolveAsset("icons", name);
  if (!existsSync(path)) {
    console.warn("Icon not found:", path);
  }
  return path;
}
