// Exit-decision logic for the orchestrator lifecycle (orchestrator-lifecycle-
// and-exit ruling 3/4). The clean/crash decision must be ACK-based — never
// exit-code guessing — and the janitor must run on every non-clean exit. These
// pure helpers are the testable core extracted from main.ts's exit handler.

import { describe, expect, it } from "vitest";
import {
  classifyOrchestratorExit,
  shouldRunJanitor,
} from "../electron/orchestrator-exit";

describe("classifyOrchestratorExit", () => {
  it("ack present ⇒ clean, regardless of a zero code", () => {
    const r = classifyOrchestratorExit({ acked: true, expected: true, code: 0 });
    expect(r.reason).toBe("clean");
    expect(r.code).toBe(0);
    expect(shouldRunJanitor(r)).toBe(false);
  });

  it("ack present ⇒ clean even with a NON-zero code (code is never the discriminator)", () => {
    // The exact case the old `code === 0` fallback got wrong: a graceful exit
    // that happens to report a non-zero code must still be clean once acked.
    const r = classifyOrchestratorExit({ acked: true, expected: false, code: 137 });
    expect(r.reason).toBe("clean");
    expect(shouldRunJanitor(r)).toBe(false);
  });

  it("no ack + main-initiated ⇒ killed (janitor runs)", () => {
    const r = classifyOrchestratorExit({ acked: false, expected: true, code: 143 });
    expect(r.reason).toBe("killed");
    expect(r.code).toBe(143);
    expect(typeof r.message).toBe("string");
    expect(shouldRunJanitor(r)).toBe(true);
  });

  it("no ack + unexpected ⇒ crash (janitor runs)", () => {
    // Native fault / signal — the exit-6-class case: no ack, main didn't ask.
    const r = classifyOrchestratorExit({ acked: false, expected: false, code: 6 });
    expect(r.reason).toBe("crash");
    expect(shouldRunJanitor(r)).toBe(true);
  });

  it("carries a null code (signal death) through untouched", () => {
    const r = classifyOrchestratorExit({ acked: false, expected: false, code: null });
    expect(r.reason).toBe("crash");
    expect(r.code).toBeNull();
  });

  it("produces the down-payload shape the bridge/renderer expect", () => {
    const r = classifyOrchestratorExit({ acked: false, expected: false, code: 11 });
    // reason ∈ union, code present, message a string on non-clean.
    expect(["clean", "killed", "crash"]).toContain(r.reason);
    expect(Object.prototype.hasOwnProperty.call(r, "code")).toBe(true);
    expect(r).toMatchObject({ reason: "crash", code: 11 });
  });
});
