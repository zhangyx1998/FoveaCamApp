// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SHARED trigger-sync PURE core decisions (spec disparity-scope §trigger-sync
// and manual-control §trigger-sync): the engage-precondition reasons the
// sessions surface as `trigger_blocked`, the achieved-rate maturity window, the
// curated engage-failure line, and the engage/disengage op chain. The
// match-join-coupled pair gating is exercised separately (trigger-sync.test.ts).

import { describe, expect, it, vi } from "vitest";
import {
  createTriggerOpChain,
  engageFailureReason,
  triggerBlockReason,
  TriggerRateWindow,
} from "@lib/trigger-sync";

const READY = {
  tripleLeased: true,
  controller: { v2Capable: true },
  streamId: 3,
};

describe("triggerBlockReason (engage preconditions)", () => {
  it("all preconditions met → null (engage)", () => {
    expect(triggerBlockReason(READY)).toBeNull();
  });

  it("names the most fundamental missing piece, in order", () => {
    expect(
      triggerBlockReason({ ...READY, tripleLeased: false, controller: null }),
    ).toBe("no camera triple leased");
    expect(triggerBlockReason({ ...READY, controller: null })).toBe(
      "no controller connected",
    );
    expect(
      triggerBlockReason({ ...READY, controller: { v2Capable: false } }),
    ).toBe("controller firmware is not v2-capable (CMD_FRAME unavailable)");
    expect(triggerBlockReason({ ...READY, streamId: null })).toBe(
      "native mirror stream not attached yet",
    );
  });
});

describe("TriggerRateWindow (hz maturity — finding 1)", () => {
  it("null until the first ≥1 s window matures, sampled at the 33 ms throttle", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let t = 33; t < 1000; t += 33) {
      w.onFin();
      expect(w.sample(t)).toBeNull(); // never a quantized 0/30 flap
    }
  });

  it("rolls at maturity with the rate over the WHOLE window", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let i = 0; i < 20; i++) w.onFin(); // 20 FINs over 1 s
    expect(w.sample(1000)).toBe(20);
  });

  it("HOLDS the last rate between rolls (throttle publishes keep reading it)", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    for (let i = 0; i < 20; i++) w.onFin();
    expect(w.sample(1000)).toBe(20);
    expect(w.sample(1033)).toBe(20); // immature next window — held
    expect(w.sample(1500)).toBe(20); // still held
    for (let i = 0; i < 5; i++) w.onFin(); // 5 FINs over the next 1 s
    expect(w.sample(2000)).toBe(5); // matured — recomputed
  });

  it("reset (re-engage) drops the held rate back to null", () => {
    const w = new TriggerRateWindow();
    w.reset(0);
    w.onFin();
    expect(w.sample(1000)).toBe(1);
    w.reset(1000);
    expect(w.sample(1033)).toBeNull();
  });
});

describe("engageFailureReason (finding 10 — curated blocked line)", () => {
  it("prefixes and keeps only the error's first line", () => {
    expect(
      engageFailureReason(new Error("TriggerMode not writable\n  at Camera.setTrigger")),
    ).toBe("engage failed: TriggerMode not writable");
  });

  it("truncates a long first line to ~80 chars", () => {
    const detail = "x".repeat(200);
    const out = engageFailureReason(new Error(detail));
    expect(out.startsWith("engage failed: ")).toBe(true);
    expect(out).toBe(`engage failed: ${"x".repeat(79)}…`);
  });

  it("stringifies non-Error throwables; empty message reads unknown", () => {
    expect(engageFailureReason("boom")).toBe("engage failed: boom");
    expect(engageFailureReason(new Error(""))).toBe("engage failed: unknown error");
  });
});

describe("createTriggerOpChain (finding 2 — engage/disengage serialization)", () => {
  it("a queued op always awaits the in-flight one (FIFO, no interleave)", async () => {
    const queue = createTriggerOpChain();
    const events: string[] = [];
    let releaseDisable!: () => void;
    const disable = queue(async () => {
      events.push("disable:start");
      await new Promise<void>((r) => (releaseDisable = r));
      events.push("disable:end");
    });
    const enable = queue(async () => {
      events.push("enable:start");
      events.push("enable:end");
    });
    await Promise.resolve();
    expect(events).toEqual(["disable:start"]); // enable is WAITING
    releaseDisable();
    await Promise.all([disable, enable]);
    expect(events).toEqual([
      "disable:start",
      "disable:end",
      "enable:start",
      "enable:end",
    ]);
  });

  it("an op failure reports via onError and never wedges the chain", async () => {
    const onError = vi.fn();
    const queue = createTriggerOpChain(onError);
    await queue(async () => {
      throw new Error("enable exploded");
    });
    expect(onError).toHaveBeenCalledTimes(1);
    const ran = vi.fn(async () => {});
    await queue(ran);
    expect(ran).toHaveBeenCalledTimes(1); // chain recovered
  });
});
