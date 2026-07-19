// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE crash-diagnostics enrichment (no fs/Electron — write + minidump scan are
// INJECTED, unit-tested): threads the per-instance output ring + any native
// minidump into the typed `orchestrator:down` report.
// spec: docs/spec/windows.md#crash-diagnostics

import type { OrchestratorDownReport } from "@lib/orchestrator/client";
import type { LogRing } from "./log-ring";

/** The per-instance capture the enrichment reads: the output ring and the fork
 *  timestamp (to attribute a minidump newer than the fork). */
export interface InstanceCapture {
  ring: LogRing;
  spawnTs: number;
}

export interface CrashDiagnosticsDeps {
  /** Persist the ring text somewhere durable; return the absolute path written,
   *  or undefined on failure (diagnostics are best-effort — a failed write must
   *  never break the down push). */
  writeLog(text: string): string | undefined;
  /** Locate a native minidump captured at/after the fork time, or undefined. */
  findDump(sinceMs: number): string | undefined;
  /** How many trailing lines to inline into the report. Default 30. */
  tailLines?: number;
}

/**
 * Enrich a down report with crash diagnostics. A `clean` exit (graceful
 * quiesce) is returned untouched — it is not a user-facing failure and captured
 * nothing worth surfacing. A non-clean exit with a captured ring gets its log
 * flushed (via the injected `writeLog`), a short tail inlined, and any minidump
 * newer than the fork cited. Never throws.
 */
export function enrichDownReport(
  report: OrchestratorDownReport,
  capture: InstanceCapture | undefined,
  deps: CrashDiagnosticsDeps,
): OrchestratorDownReport {
  if (report.reason === "clean") return report;
  if (!capture) return report;
  const enriched: OrchestratorDownReport = { ...report };
  const logPath = deps.writeLog(capture.ring.text());
  if (logPath) {
    enriched.logPath = logPath;
    enriched.lastLines = capture.ring.tail(deps.tailLines ?? 30);
  }
  const dumpPath = deps.findDump(capture.spawnTs);
  if (dumpPath) enriched.dumpPath = dumpPath;
  return enriched;
}
