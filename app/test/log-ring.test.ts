// Crash-diagnostics ring buffer (app/electron/log-ring.ts). Pure module: chunk→
// line splitting incl. partial lines, cap eviction by BOTH lines and bytes, and
// faithful tee passthrough (the dev-terminal experience must stay unchanged).

import { describe, expect, it, vi } from "vitest";
import { LogRing } from "../electron/log-ring";

describe("LogRing — chunk → line splitting", () => {
  it("splits a multi-line chunk into lines (newline stripped)", () => {
    const ring = new LogRing();
    ring.push("a\nb\nc\n");
    expect(ring.lines()).toEqual(["a", "b", "c"]);
    expect(ring.lineCount).toBe(3);
  });

  it("reassembles a line delivered across several chunks", () => {
    const ring = new LogRing();
    ring.push("hel");
    ring.push("lo wor");
    ring.push("ld\n");
    expect(ring.lines()).toEqual(["hello world"]);
  });

  it("surfaces an unterminated trailing (partial) line without a newline", () => {
    const ring = new LogRing();
    ring.push("done\nmutex lock failed");
    // The crash's last line has no trailing newline — it must still appear.
    expect(ring.lines()).toEqual(["done", "mutex lock failed"]);
    expect(ring.lineCount).toBe(1); // partial is not a *complete* line
  });

  it("promotes the partial to a complete line once its newline arrives", () => {
    const ring = new LogRing();
    ring.push("abort");
    expect(ring.lines()).toEqual(["abort"]);
    ring.push("ed\n");
    expect(ring.lines()).toEqual(["aborted"]);
    expect(ring.lineCount).toBe(1);
  });

  it("strips a trailing CR so CRLF streams don't keep dangling \\r", () => {
    const ring = new LogRing();
    ring.push("win\r\nline\r\n");
    expect(ring.lines()).toEqual(["win", "line"]);
  });

  it("accepts Buffer chunks (utf8)", () => {
    const ring = new LogRing();
    ring.push(Buffer.from("héllo\n", "utf8"));
    expect(ring.lines()).toEqual(["héllo"]);
  });

  it("ignores empty chunks", () => {
    const ring = new LogRing();
    ring.push("");
    ring.push(Buffer.alloc(0));
    expect(ring.lines()).toEqual([]);
  });
});

describe("LogRing — cap eviction by lines", () => {
  it("keeps only the last maxLines complete lines", () => {
    const ring = new LogRing({ maxLines: 3, maxBytes: 1 << 20 });
    for (let i = 0; i < 10; i++) ring.push(`line-${i}\n`);
    expect(ring.lines()).toEqual(["line-7", "line-8", "line-9"]);
    expect(ring.lineCount).toBe(3);
  });

  it("tail(n) returns the last n lines (or fewer)", () => {
    const ring = new LogRing();
    for (let i = 0; i < 5; i++) ring.push(`L${i}\n`);
    expect(ring.tail(2)).toEqual(["L3", "L4"]);
    expect(ring.tail(100)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
    expect(ring.tail(0)).toEqual([]);
  });

  it("tail includes the trailing partial line", () => {
    const ring = new LogRing();
    ring.push("a\nb\nc"); // c has no newline
    expect(ring.tail(2)).toEqual(["b", "c"]);
  });
});

describe("LogRing — cap eviction by bytes", () => {
  it("evicts oldest lines once the byte cap is exceeded", () => {
    // Each "xxxx\n" line = 5 bytes. Cap at 12 bytes → at most 2 lines retained.
    const ring = new LogRing({ maxLines: 1000, maxBytes: 12 });
    ring.push("xxxx\nxxxx\nxxxx\nxxxx\n");
    expect(ring.lineCount).toBeLessThanOrEqual(2);
    expect(ring.byteCount).toBeLessThanOrEqual(12);
  });

  it("always keeps at least one line even if it alone exceeds the byte cap", () => {
    const ring = new LogRing({ maxLines: 1000, maxBytes: 4 });
    ring.push("a-very-long-single-line\n");
    expect(ring.lineCount).toBe(1);
    expect(ring.lines()).toEqual(["a-very-long-single-line"]);
  });

  it("counts multibyte characters by byte length, not char length", () => {
    // "€" is 3 bytes. Two lines "€\n" = 8 bytes total.
    const ring = new LogRing({ maxLines: 1000, maxBytes: 5 });
    ring.push("€\n€\n");
    // Second line (4 bytes) exceeds the 5-byte cap alongside the first → evict.
    expect(ring.lineCount).toBe(1);
  });

  it("commits an over-cap newline-less partial so it can't grow unbounded", () => {
    const ring = new LogRing({ maxLines: 1000, maxBytes: 4 });
    ring.push("abcdefghij"); // 10 bytes, no newline, exceeds the 4-byte cap
    // Flushed to a complete line rather than held forever in `partial`.
    expect(ring.lineCount).toBe(1);
    expect(ring.lines()).toEqual(["abcdefghij"]);
  });
});

describe("LogRing — tee passthrough", () => {
  it("forwards every raw chunk to the tee, in order, before line accounting", () => {
    const ring = new LogRing();
    const seen: Array<string | Buffer> = [];
    const tee = (c: string | Buffer) => seen.push(c);
    ring.push("one\n", tee);
    ring.push("two", tee);
    const buf = Buffer.from("three\n");
    ring.push(buf, tee);
    // Raw chunks, verbatim and in order (the terminal sees exactly the child).
    expect(seen).toEqual(["one\n", "two", buf]);
  });

  it("does not require a tee (ring works without passthrough)", () => {
    const ring = new LogRing();
    expect(() => ring.push("no-tee\n")).not.toThrow();
    expect(ring.lines()).toEqual(["no-tee"]);
  });

  it("tees the exact same reference it was handed (no copy)", () => {
    const ring = new LogRing();
    const tee = vi.fn();
    const buf = Buffer.from("chunk\n");
    ring.push(buf, tee);
    expect(tee).toHaveBeenCalledTimes(1);
    expect(tee.mock.calls[0][0]).toBe(buf);
  });
});

describe("LogRing — text()", () => {
  it("joins retained lines with newlines (a crash-log file body)", () => {
    const ring = new LogRing();
    ring.push("first\nsecond\nthird");
    expect(ring.text()).toBe("first\nsecond\nthird");
  });
});
