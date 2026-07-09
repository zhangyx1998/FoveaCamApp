// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure orchestrator-exit classification (orchestrator-lifecycle-and-exit
// ruling 3/4). Extracted from main.ts so the clean/crash decision is unit-
// testable without the Electron runtime (test/orchestrator-exit.test.ts).
//
// THE RULE (deterministic, not exit-code guessing): the graceful path posts a
// `quiesced` ACK to main BEFORE it stops. Main records whether that ack
// arrived; on the orchestrator's exit the decision is:
//   - ack present            → "clean"   (a graceful, hardware-safe shutdown)
//   - no ack, main asked it to stop → "killed"  (quit / hung-quiesce timeout)
//   - no ack, unexpected     → "crash"   (native fault, signal, OOM)
// The exit CODE is informational only — never the discriminator. This replaces
// the old `code === 0` fallback + 100ms flush hack the W1 audit flagged.

import type { OrchestratorDownReport } from "@lib/orchestrator/client";

export type { OrchestratorDownReport };

export interface ExitSignals {
  /** The `quiesced` clean-exit ack was received from the orchestrator before it
   *  exited. Authoritative for clean vs not-clean. */
  acked: boolean;
  /** Main initiated the termination (sent `shutdown` / called `kill()` on the
   *  quit or dev-restart path). Distinguishes an expected "killed" from an
   *  unexpected "crash" when no ack arrived. */
  expected: boolean;
  /** Process exit code, or null for a signal/unknown death. */
  code: number | null;
}

/** Classify an orchestrator exit into the down-report the crash surface + the
 *  janitor decision key on. */
export function classifyOrchestratorExit(signals: ExitSignals): OrchestratorDownReport {
  const { acked, expected, code } = signals;
  if (acked) return { reason: "clean", code };
  if (expected)
    return {
      reason: "killed",
      code,
      message: "Orchestrator was terminated before confirming a clean shutdown.",
    };
  return {
    reason: "crash",
    code,
    message: "Orchestrator exited unexpectedly.",
  };
}

/** Whether the hardware janitor must run for this exit — every non-clean exit
 *  (killed OR crash) may have left MEMS energized / cameras streaming. A clean
 *  exit already quiesced in-process, so the janitor is skipped. */
export function shouldRunJanitor(report: OrchestratorDownReport): boolean {
  return report.reason !== "clean";
}
