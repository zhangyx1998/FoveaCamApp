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
// the orchestrator console. See docs/history/refactor/orchestrator.md §12.1 C7.
//
// `span()` is the S5 sibling: structured timing measurements (boot phases,
// per-activation camera/calibration work, controller connect) instead of
// failures. Same shape as `report`/`onReport` — always recorded locally
// (bounded ring, cheap enough to be always-on), forwarded to renderers via
// `onSpan()` so a future profiler window (§7.1 S4) can render a live
// timeline without polling.

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

/** A single structured timing measurement (docs/history/refactor/orchestrator.md §7.1 S5). */
export type Span = {
  name: string;
  ms: number;
  meta?: Record<string, unknown>;
  /** Host `Date.now()` when the span was recorded — same clock as `FrameMeta`. */
  t: number;
};

const RING_CAPACITY = 200;
const ring: Span[] = [];
type SpanReporter = (span: Span) => void;
let spanForward: SpanReporter | null = null;

/** Register the sink that forwards spans to renderers (set once, by index.ts). */
export function onSpan(fn: SpanReporter): void {
  spanForward = fn;
}

/** Record a precomputed duration. Always recorded into the bounded local ring
 *  (cheap — this is meant to be called from hot-ish paths like activation)
 *  and forwarded live to renderers; console line only under
 *  `FOVEA_DEBUG_SPANS` (kept quiet by default — this is for manual digging,
 *  not routine logs). */
export function span(name: string, ms: number, meta?: Record<string, unknown>): void {
  const s: Span = { name, ms, meta, t: Date.now() };
  ring.push(s);
  if (ring.length > RING_CAPACITY) ring.shift();
  if (process.env.FOVEA_DEBUG_SPANS)
    console.debug(`[span] ${name}: ${ms.toFixed(1)}ms`, meta ?? "");
  spanForward?.(s);
}

/** Measure `fn` and record it as a span in one call. */
export async function timeSpan<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    span(name, performance.now() - t0, meta);
  }
}

/** The current ring buffer contents — `system.perfSnapshot` dumps this. */
export function spans(): readonly Span[] {
  return ring;
}
