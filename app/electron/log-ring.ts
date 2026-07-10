// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Crash-diagnostics ring buffer (orchestrator-lifecycle-and-exit §"Crash
// diagnostics"). The orchestrator instance is forked with piped stdio (main.ts
// `forkInstance`); every chunk is TEE'd faithfully to the parent's
// stdout/stderr (so the dev-terminal experience is unchanged) while this ring
// keeps a bounded, line-oriented tail of the last output. On a non-clean exit
// main flushes the ring to `<userData>/crash-logs/…` and inlines a short tail
// into the typed `orchestrator:down` report.
//
// Deliberately PURE (no Electron, no fs, no `process`): the tee is an injected
// callback and the ring only accounts lines/bytes, so the whole thing is
// unit-testable (test/log-ring.test.ts) — chunk→line splitting incl. partial
// lines, cap eviction by both lines and bytes, and faithful tee passthrough.

/** A faithful passthrough sink — receives the RAW chunk (never a reassembled
 *  copy) so the parent terminal sees exactly the child's bytes, unbuffered. */
export type TeeFn = (chunk: string | Buffer) => void;

export interface LogRingOptions {
  /** Max retained complete lines (oldest evicted first). Default 256. */
  maxLines?: number;
  /** Max retained bytes across complete lines (newline included). Default 64 KiB.
   *  At least one line is always kept even if it alone exceeds the cap. */
  maxBytes?: number;
}

const DEFAULT_MAX_LINES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * A bounded, line-oriented tail of a text stream. `push` accepts arbitrary
 * chunks (as a pipe delivers them — split mid-line, multiple lines at once, or
 * with no trailing newline) and, if a tee is supplied, forwards the raw chunk
 * FIRST (immediate, unbuffered) before any line accounting. Retention is capped
 * by whichever of `maxLines` / `maxBytes` binds first; the current unterminated
 * partial line is surfaced by the readers so a crash's last (newline-less) line
 * is never lost.
 */
export class LogRing {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  /** Complete lines (newline stripped), oldest first. */
  private readonly buf: string[] = [];
  /** Byte total of `buf`, counting one newline per line. */
  private bytes = 0;
  /** Trailing bytes not yet terminated by a newline. */
  private partial = "";

  constructor(opts: LogRingOptions = {}) {
    this.maxLines = Math.max(1, opts.maxLines ?? DEFAULT_MAX_LINES);
    this.maxBytes = Math.max(1, opts.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /** Feed one chunk. `tee` (if given) receives the raw chunk before any
   *  processing — a faithful, order-preserving passthrough to the terminal. */
  push(chunk: string | Buffer, tee?: TeeFn): void {
    if (tee) tee(chunk);
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length === 0) return;
    this.partial += text;
    let nl: number;
    while ((nl = this.partial.indexOf("\n")) !== -1) {
      // Strip a trailing \r so CRLF streams don't leave a dangling carriage
      // return on each retained line.
      let line = this.partial.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.partial = this.partial.slice(nl + 1);
      this.append(line);
    }
    // Guard against an unbounded partial (a producer that never emits a
    // newline): once it alone exceeds the byte cap, commit it as a line.
    if (byteLen(this.partial) > this.maxBytes) {
      const line = this.partial;
      this.partial = "";
      this.append(line);
    }
  }

  private append(line: string): void {
    this.buf.push(line);
    this.bytes += byteLen(line) + 1;
    while (
      this.buf.length > this.maxLines ||
      (this.bytes > this.maxBytes && this.buf.length > 1)
    ) {
      const removed = this.buf.shift() as string;
      this.bytes -= byteLen(removed) + 1;
    }
  }

  /** All retained complete lines plus the current partial (if any), oldest
   *  first. */
  lines(): string[] {
    return this.partial.length ? [...this.buf, this.partial] : [...this.buf];
  }

  /** The last `n` lines (fewer if the ring holds fewer). */
  tail(n: number): string[] {
    if (n <= 0) return [];
    const all = this.lines();
    return all.length <= n ? all : all.slice(all.length - n);
  }

  /** The retained tail as a single newline-joined string (a crash-log file). */
  text(): string {
    return this.lines().join("\n");
  }

  /** Retained complete-line count (excludes the partial) — for tests. */
  get lineCount(): number {
    return this.buf.length;
  }

  /** Retained byte total across complete lines — for tests. */
  get byteCount(): number {
    return this.bytes;
  }
}
