// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// ffmpeg DISCOVERY for the viewer export (viewer-export.md spec 1). The IMPORTANT
// nuance: an Electron app launched from Finder inherits launchd's minimal PATH
// (no /opt/homebrew/bin), so a PATH-only probe misses a Homebrew/MacPorts ffmpeg.
// We therefore search PATH *plus* the well-known install locations and remember
// the resolved ABSOLUTE path for spawning. Detection runs in the utility process
// (the viewer engine), never the renderer.
//
// The resolver core is pure (injected `exists` + PATH string) so it is unit-
// tested (test/viewer-export.test.ts); `resolveFfmpeg` binds it to the real fs.

import { existsSync } from "node:fs";

/** Well-known non-PATH install prefixes (spec 1). Ordered by prevalence on
 *  macOS: Apple-silicon Homebrew, Intel Homebrew / older, MacPorts. */
export const COMMON_FFMPEG_PATHS = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
] as const;

/** Pure resolver: the first existing ffmpeg across PATH entries then the common
 *  locations, or null. `pathEnv` is the raw `PATH` string; `sep` its separator
 *  (":" on posix). `exists` probes a candidate absolute path. */
export function resolveFfmpegPath(
  pathEnv: string | undefined,
  exists: (p: string) => boolean,
  common: readonly string[] = COMMON_FFMPEG_PATHS,
  sep = ":",
  binary = "ffmpeg",
): string | null {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of (pathEnv ?? "").split(sep)) {
    if (!dir) continue;
    const p = dir.endsWith("/") ? dir + binary : `${dir}/${binary}`;
    if (!seen.has(p)) {
      seen.add(p);
      candidates.push(p);
    }
  }
  for (const p of common) if (!seen.has(p)) {
    seen.add(p);
    candidates.push(p);
  }
  for (const p of candidates) if (exists(p)) return p;
  return null;
}

/** Resolve ffmpeg against the real process env + fs. Returns the absolute path
 *  or null (the export entry point then shows the "ffmpeg missing" hint). */
export function resolveFfmpeg(): string | null {
  return resolveFfmpegPath(process.env.PATH, existsSync);
}
