// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  statSync,
  accessSync,
  constants as fs_flags,
} from "node:fs";

// Node-only (main process). Not reachable from the renderer directly once
// contextIsolation is on — `node:fs`/`node:os` need a real `require`, which
// the renderer only gets under `nodeIntegration: true`
// (docs/refactor/orchestrator.md §7.1 T5). The renderer calls these
// indirectly via `window.foveaBridge`, whose `preload.ts`/`main.ts` wiring
// forwards straight into these functions.

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

/** Preferred default save directory for a capture/recording namespace: an
 *  external volume if mounted, else `~/Downloads/<directory>`. */
export function resolveDefaultSavePath(directory: string): string {
  if (existsSync("/Volumes/Yuxuan Mobile/"))
    return resolve("/Volumes/Yuxuan Mobile/", directory);
  return resolve(homedir(), "Downloads", directory);
}
