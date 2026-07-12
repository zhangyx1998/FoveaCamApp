// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Process-wide error reporting + timing for orchestrator code with no single owning
// session. report() always logs locally; onReport() lets index.ts forward reports to
// every connected renderer (visible without watching the console). span() is the timing
// sibling: structured measurements recorded to a bounded local ring, forwarded via
// onSpan() so a profiler window can render a live timeline without polling.
// spec: docs/spec/orchestrator-runtime.md#diagnostics

/** Tray severity: "error" = failure (danger identity), "warning" = degraded
 *  state the operator should notice but nothing broke. */
export type ReportLevel = "error" | "warning";

type Reporter = (scope: string, message: string, level: ReportLevel) => void;
let forward: Reporter | null = null;

/** Register the sink that forwards reports to renderers (set once, by index.ts). */
export function onReport(fn: Reporter): void {
  forward = fn;
}

export function report(
  scope: string,
  message: string,
  level: ReportLevel = "error",
): void {
  if (level === "warning") console.warn(`[${scope}]`, message);
  else console.error(`[${scope}]`, message);
  forward?.(scope, message, level);
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
