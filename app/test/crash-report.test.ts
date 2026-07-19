// Crash-diagnostics enrichment (app/electron/crash-report.ts). Pure module —
// the file write + minidump scan are injected — so the down-report field
// threading is testable with fakes: a non-clean exit gains {logPath, lastLines,
// dumpPath}; a clean exit and a captureless exit pass through untouched.

import { describe, expect, it, vi } from "vitest";
import { enrichDownReport, type CrashDiagnosticsDeps } from "../electron/crash-report";
import { LogRing } from "../electron/log-ring";
import type { OrchestratorDownReport } from "@lib/orchestrator/client";

function capture(lines: string[], spawnTs = 1000) {
  const ring = new LogRing();
  ring.push(lines.map((l) => l + "\n").join(""));
  return { ring, spawnTs };
}

function deps(over: Partial<CrashDiagnosticsDeps> = {}): CrashDiagnosticsDeps {
  return {
    writeLog: () => "/data/crash-logs/hw-2-2026.log",
    findDump: () => undefined,
    ...over,
  };
}

describe("enrichDownReport — non-clean exits", () => {
  it("threads logPath + a tail into a crash report", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: 6 };
    const out = enrichDownReport(report, capture(["boot", "mutex lock failed"]), deps());
    expect(out.reason).toBe("crash");
    expect(out.code).toBe(6);
    expect(out.logPath).toBe("/data/crash-logs/hw-2-2026.log");
    expect(out.lastLines).toEqual(["boot", "mutex lock failed"]);
  });

  it("threads a minidump path when one is found", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: null };
    const findDump = vi.fn(() => "/data/crash-dumps/completed/abc.dmp");
    const out = enrichDownReport(report, capture(["x"], 5000), deps({ findDump }));
    expect(out.dumpPath).toBe("/data/crash-dumps/completed/abc.dmp");
    // Attribution keys on the fork time.
    expect(findDump).toHaveBeenCalledWith(5000);
  });

  it("omits dumpPath when no minidump is found", () => {
    const report: OrchestratorDownReport = { reason: "killed", code: null };
    const out = enrichDownReport(report, capture(["a"]), deps({ findDump: () => undefined }));
    expect(out.dumpPath).toBeUndefined();
    expect(out.reason).toBe("killed");
  });

  it("honors a custom tail length", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: 1 };
    const cap = capture(["l0", "l1", "l2", "l3", "l4"]);
    const out = enrichDownReport(report, cap, deps({ tailLines: 2 }));
    expect(out.lastLines).toEqual(["l3", "l4"]);
  });

  it("still surfaces the report when the log write fails (no logPath/tail)", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: 6 };
    const out = enrichDownReport(report, capture(["x"]), deps({ writeLog: () => undefined }));
    expect(out.logPath).toBeUndefined();
    expect(out.lastLines).toBeUndefined();
    // The base classification is preserved regardless.
    expect(out.reason).toBe("crash");
  });
});

describe("enrichDownReport — pass-through cases", () => {
  it("returns a clean report untouched (never writes a log)", () => {
    const report: OrchestratorDownReport = { reason: "clean", code: 0 };
    const writeLog = vi.fn();
    const out = enrichDownReport(report, capture(["x"]), deps({ writeLog }));
    expect(out).toEqual({ reason: "clean", code: 0 });
    expect(writeLog).not.toHaveBeenCalled();
  });

  it("returns a non-clean report untouched when no capture exists", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: 6 };
    const writeLog = vi.fn();
    const out = enrichDownReport(report, undefined, deps({ writeLog }));
    expect(out).toEqual({ reason: "crash", code: 6 });
    expect(writeLog).not.toHaveBeenCalled();
  });

  it("does not mutate the input report object", () => {
    const report: OrchestratorDownReport = { reason: "crash", code: 6 };
    enrichDownReport(report, capture(["x"]), deps());
    expect(report).toEqual({ reason: "crash", code: 6 });
  });
});
