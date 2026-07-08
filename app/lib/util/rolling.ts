// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Vue-free rolling-average/frequency meter, same decay math as
// `@lib/util/perf.ts`'s `RollingAverage`/`FreqMeter` but backed by a plain
// number instead of a Vue `ref`. For orchestrator-reachable code only — the
// orchestrator must stay Vue-free, and `perf.ts` is intentionally Vue-tainted
// (its `ref` is load-bearing for `StreamView`'s reactive OSD). Don't merge
// these two; they exist for disjoint audiences.

export class RollingAverage {
  private init = true;
  private raw = 0;

  constructor(
    public readonly decay: number = 0.9,
    private readonly digits: number = 2,
    private readonly unit: string | null = null,
  ) {}

  get value() {
    return this.raw;
  }

  roll(v: number) {
    if (this.init) {
      this.raw = v;
      this.init = false;
    } else {
      this.raw = this.raw * this.decay + v * (1.0 - this.decay);
    }
  }

  reset(v: number | null = null) {
    if (v === null) {
      this.init = true;
      this.raw = 0;
    } else {
      this.raw = v;
    }
  }

  toString() {
    const ret = this.value.toFixed(this.digits);
    return this.unit ? ret + " " + this.unit : ret;
  }
}

export class FreqMeter extends RollingAverage {
  private lastTick: number | null = null;

  constructor(decay: number = 0.9, digits: number = 2, unit: string | null = "Hz") {
    super(decay, digits, unit);
  }

  tick() {
    const now = performance.now();
    if (this.lastTick !== null) this.roll(now - this.lastTick);
    this.lastTick = now;
  }

  get value() {
    return super.value === 0 ? 0 : 1000 / super.value;
  }

  reset(v: number | null = null) {
    super.reset(v);
    this.lastTick = null;
  }
}

/**
 * Mean (EMA, same math as `RollingAverage`) + max, for perf-substrate
 * telemetry (docs/history/refactor/orchestrator.md §7.3) — e.g. event-loop lag,
 * control-path latency. `max` is a plain running max, not a decayed one:
 * decaying a max isn't mathematically coherent (it would just chase whatever
 * value arrives most recently under a multiplicative decay). Callers publish
 * on a cadence and call `resetMax()` after each publish so `max` means "since
 * the last snapshot," not "ever."
 */
export class RollingStats {
  private readonly meanTracker: RollingAverage;
  private maxValue = 0;
  count = 0;

  constructor(
    decay: number = 0.9,
    private readonly digits: number = 2,
    private readonly unit: string | null = null,
  ) {
    this.meanTracker = new RollingAverage(decay, digits, unit);
  }

  push(v: number) {
    this.meanTracker.roll(v);
    if (v > this.maxValue) this.maxValue = v;
    this.count++;
  }

  get mean() {
    return this.meanTracker.value;
  }

  get max() {
    return this.maxValue;
  }

  /** Clear the running max (call after publishing a snapshot). Mean and
   *  count are cumulative — `RollingAverage`'s decay already bounds how much
   *  old samples matter. */
  resetMax() {
    this.maxValue = 0;
  }

  toString() {
    const unit = this.unit ? " " + this.unit : "";
    return `${this.mean.toFixed(this.digits)}${unit} (max ${this.max.toFixed(this.digits)}${unit})`;
  }
}

/**
 * Event-loop lag probe (docs/history/refactor/orchestrator.md §7.3 item 1) — the
 * "own libuv loop" metric: a `setInterval(intervalMs)` that measures how much
 * *later* than expected each tick actually fires. Under load on the same
 * event loop (heavy sync work, GC pauses, a busy renderer's layout/paint),
 * lag rises; a healthy decoupled loop stays flat regardless of what the
 * *other* process is doing. Vue-free — usable from the orchestrator or the
 * renderer (the renderer's own copy feeds the inspector OSD, not
 * `client.ts`'s Vue reactivity, so it stays here rather than in `perf.ts`).
 */
export interface LoopLagProbe {
  readonly stats: RollingStats;
  stop(): void;
}

export function startLoopLagProbe(intervalMs = 200): LoopLagProbe {
  const stats = new RollingStats(0.9, 2, "ms");
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - last - intervalMs);
    last = now;
    stats.push(lag);
  }, intervalMs);
  return {
    stats,
    stop: () => clearInterval(timer),
  };
}
