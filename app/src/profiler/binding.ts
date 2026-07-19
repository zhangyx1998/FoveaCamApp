// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE presentation helpers for the profiler's per-instance binding (Vue-free,
// side-effect-free, unit-tested): title/subtitle + session-end formatting.
// spec: docs/spec/profiler-graph.md#binding (lifecycle: windows.md#profiler-binding)

import type { OrchestratorDownReport } from "@lib/orchestrator/client";

/** Compact form of an instance id for the title bar (e.g. `manual-control ·
 *  #hw-1`). Already-short ids (`hw-1`) pass through; a long/opaque id collapses
 *  to its trailing 6 chars so the subtitle never overflows the bar. */
export function shortInstanceId(id: string): string {
  return id.length > 10 ? id.slice(-6) : id;
}

/** Title-bar subtitle for a profiler bound to `sessionName` / `instanceId`
 *  (the session name + instance id). Unbound (opened with no live
 *  instance) reads "no active session". */
export function profilerSubtitle(
  sessionName: string | null | undefined,
  instanceId: string | null | undefined,
): string {
  if (!instanceId) return "no active session";
  const short = `#${shortInstanceId(instanceId)}`;
  return sessionName ? `${sessionName} · ${short}` : short;
}

/** The frozen end-state a bound profiler shows once its instance goes down. A
 *  `crash` is the alarm case (unexpected native fault / signal); `clean`
 *  (graceful) and `killed` (quit / hung-quiesce timeout) are both a normal
 *  end. Distinguished off the SAME typed report the crash surface keys on —
 *  never exit-code guessing. */
export interface SessionEndState {
  crashed: boolean;
  title: string;
  detail: string;
}

export function describeSessionEnd(report: OrchestratorDownReport): SessionEndState {
  const code = report.code === null ? "" : ` (exit code ${report.code})`;
  if (report.reason === "crash")
    return {
      crashed: true,
      title: "Session crashed",
      detail: `${report.message ?? "The orchestrator exited unexpectedly."}${code} This profiler is frozen — its captured data stays inspectable below.`,
    };
  return {
    crashed: false,
    title: "Session ended",
    detail: `The profiled session has closed${code}. This profiler is frozen — its captured data stays inspectable below.`,
  };
}
