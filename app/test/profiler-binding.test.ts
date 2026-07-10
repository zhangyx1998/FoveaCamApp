// Pure profiler binding presentation (orchestrator-lifecycle-and-exit
// §"Profiler per-instance binding"): the title-bar subtitle (session · #short
// id) and the frozen session-end state (clean vs crash off the typed report).

import { describe, expect, it } from "vitest";
import {
  shortInstanceId,
  profilerSubtitle,
  describeSessionEnd,
} from "../src/profiler/binding";
import type { OrchestratorDownReport } from "@lib/orchestrator/client";

describe("shortInstanceId", () => {
  it("passes an already-short id through unchanged", () => {
    expect(shortInstanceId("hw-1")).toBe("hw-1");
    expect(shortInstanceId("hw-42")).toBe("hw-42");
  });
  it("collapses a long/opaque id to its trailing 6 chars", () => {
    expect(shortInstanceId("instance-a3f2c1")).toBe("a3f2c1");
  });
});

describe("profilerSubtitle", () => {
  it("formats session · #short-id when bound", () => {
    expect(profilerSubtitle("manual-control", "hw-1")).toBe("manual-control · #hw-1");
  });
  it("shows only the short id when the session name is absent", () => {
    expect(profilerSubtitle(null, "hw-3")).toBe("#hw-3");
  });
  it("reads 'no active session' when unbound (no instance id)", () => {
    expect(profilerSubtitle("manual-control", null)).toBe("no active session");
    expect(profilerSubtitle(null, undefined)).toBe("no active session");
  });
});

describe("describeSessionEnd", () => {
  const report = (r: OrchestratorDownReport) => r;

  it("flags a crash (alarm state) and keeps the code in the detail", () => {
    const s = describeSessionEnd(report({ reason: "crash", code: 6, message: "boom" }));
    expect(s.crashed).toBe(true);
    expect(s.title).toBe("Session crashed");
    expect(s.detail).toContain("boom");
    expect(s.detail).toContain("exit code 6");
  });

  it("treats a clean end as a normal (non-crash) close", () => {
    const s = describeSessionEnd(report({ reason: "clean", code: 0 }));
    expect(s.crashed).toBe(false);
    expect(s.title).toBe("Session ended");
  });

  it("treats a killed (quit / hung-quiesce) end as non-crash too", () => {
    const s = describeSessionEnd(report({ reason: "killed", code: null }));
    expect(s.crashed).toBe(false);
    expect(s.title).toBe("Session ended");
    // A null code is omitted, not printed as "null".
    expect(s.detail).not.toContain("null");
  });
});
