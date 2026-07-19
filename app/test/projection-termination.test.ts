// Projection per-pane termination/rebind machine: live → frozen(cover) →
// rebound | terminated, under fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allTerminated,
  DEFAULT_GRACE_MS,
  TerminationMachine,
} from "@lib/projection/termination";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TerminationMachine", () => {
  it("starts live with no cover", () => {
    const m = new TerminationMachine();
    expect(m.snapshot()).toEqual({ status: "live", coverVisible: false });
  });

  it("sourceLost → frozen with a visible cover; grace elapses → terminated", () => {
    const changes: string[] = [];
    const m = new TerminationMachine({ graceMs: 1000, onChange: (s) => changes.push(s.status) });
    m.sourceLost();
    expect(m.snapshot()).toEqual({ status: "frozen", coverVisible: true });
    expect(m.terminated).toBe(false);
    vi.advanceTimersByTime(999);
    expect(m.snapshot().status).toBe("frozen");
    vi.advanceTimersByTime(1);
    expect(m.snapshot().status).toBe("terminated");
    expect(m.snapshot().coverVisible).toBe(false);
    expect(m.terminated).toBe(true);
    expect(changes).toEqual(["frozen", "terminated"]);
  });

  it("sourceReturned before grace = rebind to live (cancels the timer)", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    vi.advanceTimersByTime(500);
    m.sourceReturned();
    expect(m.snapshot().status).toBe("live");
    // The old timer must not fire us back to terminated.
    vi.advanceTimersByTime(1000);
    expect(m.snapshot().status).toBe("live");
  });

  it("sourceReturned after termination rebinds a dead pane", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    vi.advanceTimersByTime(1000);
    expect(m.terminated).toBe(true);
    m.sourceReturned();
    expect(m.snapshot().status).toBe("live");
    expect(m.terminated).toBe(false);
  });

  it("dismissCover hides the note but keeps frozen + the running timer", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    m.dismissCover();
    expect(m.snapshot()).toEqual({ status: "frozen", coverVisible: false });
    // Timer still counts down to termination.
    vi.advanceTimersByTime(1000);
    expect(m.snapshot().status).toBe("terminated");
  });

  it("sourceLost is idempotent while frozen (does not restart the grace)", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    vi.advanceTimersByTime(600);
    m.sourceLost(); // must NOT re-arm
    vi.advanceTimersByTime(400);
    expect(m.snapshot().status).toBe("terminated");
  });

  it("a fresh loss after a rebind re-shows the cover and re-arms grace", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    m.dismissCover();
    m.sourceReturned();
    m.sourceLost();
    expect(m.snapshot().coverVisible).toBe(true);
  });

  it("dispose cancels the pending grace timer", () => {
    const m = new TerminationMachine({ graceMs: 1000 });
    m.sourceLost();
    m.dispose();
    vi.advanceTimersByTime(2000);
    expect(m.snapshot().status).toBe("frozen"); // never terminated
  });

  it("defaults to the ~10 s grace constant", () => {
    const m = new TerminationMachine();
    m.sourceLost();
    vi.advanceTimersByTime(DEFAULT_GRACE_MS - 1);
    expect(m.snapshot().status).toBe("frozen");
    vi.advanceTimersByTime(1);
    expect(m.snapshot().status).toBe("terminated");
  });
});

describe("allTerminated", () => {
  it("is true only when every pane is terminated and the set is non-empty", () => {
    expect(allTerminated([])).toBe(false);
    expect(allTerminated(["terminated", "terminated"])).toBe(true);
    expect(allTerminated(["terminated", "frozen"])).toBe(false);
    expect(allTerminated(["live"])).toBe(false);
  });
});
