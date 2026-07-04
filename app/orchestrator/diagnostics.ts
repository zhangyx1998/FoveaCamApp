// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Process-wide error reporting for orchestrator code with no single owning
// session (the camera registry is shared across sessions) or that would
// otherwise fail silently into the utility process's stdio. `report()` always
// logs locally; `onReport()` lets `index.ts` forward reports to every
// connected renderer once, at boot, so failures are visible without watching
// the orchestrator console. See docs/refactor/orchestrator.md §12.1 C7.

type Reporter = (scope: string, message: string) => void;
let forward: Reporter | null = null;

/** Register the sink that forwards reports to renderers (set once, by index.ts). */
export function onReport(fn: Reporter): void {
  forward = fn;
}

export function report(scope: string, message: string): void {
  console.error(`[${scope}]`, message);
  forward?.(scope, message);
}

/** Run `fn`, reporting (and swallowing) any throw instead of propagating it. */
export function guarded(scope: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    report(scope, e instanceof Error ? e.message : String(e));
  }
}
