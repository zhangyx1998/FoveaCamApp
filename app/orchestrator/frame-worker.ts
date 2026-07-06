// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared latest-wins processing gate for `onView` sinks that need to run
// non-trivial vision work before publishing a display frame (PB3 A-5, docs/
// refactor/orchestrator.md §6). The registry's camera loop
// (`registry.ts`'s `startLoop`: `for (const frame of s.camera.stream) { ...
// publish(s.serial, s.viewSinks, ...) ... }`) invokes every `onView` sink
// *synchronously*, and does not `await frame.view(...)` for the next frame
// until that whole iteration — every sink included — returns. A sink that
// runs ms-scale inline work (undistort remap, perspective wrap, disparity/
// depth) therefore stalls the loop's next pull, throttling *every* consumer
// of that camera serial, not just the slow session.
//
// The fix: the sink itself does only a synchronous copy of the (reused) tap
// buffer and hands off to this gate; the actual vision + publish runs later,
// off the sink's call stack, via `setImmediate` — a real event-loop turn, not
// a same-tick microtask, so the registry's loop genuinely regains control
// before the heavy work runs (mirrors the same `setImmediate` yield the
// registry's own loop uses to avoid spinning on "no frame ready"). While a
// run is in flight, further submissions coalesce onto a single pending slot
// — latest wins, exactly like disparity-scope's own `step()` reentrancy gate,
// generalized here so manual-control's display-vision path gets it too.
//
// Copy-before-await: `copy` runs synchronously inside `submit()`, before the
// deferred `process()` ever touches the value — safe against a reused
// registry tap buffer per the hard rule in docs/refactor/orchestrator.md §3.
//
// Perf substrate (docs/refactor/workload-metering.md, "frame-worker gates
// (per session/view)" — first citizen): every worker self-registers a
// `Workload` meter so its existing busy-drop counting (coalesced submits,
// cancelled runs) becomes an instance of the shared schema instead of a
// bespoke `busy` flag. Each call site (session.ts, not this file's ownership
// this round) can pass `name` for a meaningful identity; without one, an
// auto id is used so metering still lights up today. Callers should call the
// new `dispose()` on session idle/teardown to release the meter — until that
// wiring lands (an A-owned follow-up in app/modules/**), entries persist
// under their auto id for the process lifetime, which is a metering-only
// side effect (no change to the actual gate behavior).

import { registerWorkload } from "./metering.js";

export interface FrameWorkerOptions<TIn, TOut> {
  /** Synchronous copy off the (possibly reused) tap buffer into a value safe
   *  to read after this call returns — see the copy-before-await note above. */
  copy(input: TIn): TOut;
  /** The vision work + publish. Only one run is ever in flight; never called
   *  reentrantly with itself. May be synchronous or return a Promise. */
  process(latest: TOut): void | Promise<void>;
  /** Workload meter identity (docs/refactor/workload-metering.md). Defaults
   *  to an auto id (`frame-worker:<n>`) if omitted. */
  name?: string;
}

export interface FrameWorker<TIn> {
  /** Call from the `onView` sink. Synchronous and fast: copies the tap and
   *  schedules (or coalesces into) the pending run; never awaits. */
  submit(input: TIn): void;
  /**
   * Discard any pending/scheduled-but-not-yet-run frame without processing
   * it. Call this on session idle/dispose: `submit()`'s copy happens
   * synchronously, but `process()` runs on a deferred `setImmediate` turn —
   * without `cancel()`, a frame copied just before idle can still get
   * processed after teardown, against a fresh re-activation's state (the
   * V5/V10/V13 stale-async-completion class). Safe to call while a run is
   * already executing (synchronous `process()` bodies can't be interrupted
   * mid-call, but their *result* is simply not awaited by anyone external —
   * this only prevents a *future* scheduled run from firing against stale
   * state).
   */
  cancel(): void;
  /** True while a run is scheduled or in flight (mostly for tests). */
  readonly busy: boolean;
  /** Release this worker's `Workload` meter (docs/refactor/
   *  workload-metering.md). Additive — existing callers that never call this
   *  see no behavior change; call it alongside `cancel()` at session
   *  idle/teardown once a call site is wired to. Idempotent. */
  dispose(): void;
}

let autoId = 0;

export function createFrameWorker<TIn, TOut>(
  opts: FrameWorkerOptions<TIn, TOut>,
): FrameWorker<TIn> {
  let latest: TOut | null = null;
  let busy = false;
  let generation = 0; // bumped by `cancel()` — invalidates any already-scheduled run
  const workload = registerWorkload(opts.name ?? `frame-worker:${++autoId}`, {
    inputs: ["input"],
    outputs: ["processed"],
  });

  function runDrain(myGeneration: number): void {
    const value = latest;
    latest = null;
    if (value === null || myGeneration !== generation) {
      busy = false;
      return;
    }
    void Promise.resolve(workload.measure(() => opts.process(value))).finally(() => {
      if (myGeneration !== generation) {
        busy = false;
        return;
      }
      workload.emit("processed");
      if (latest !== null) {
        setImmediate(() => runDrain(myGeneration)); // a newer frame coalesced in while busy
      } else {
        busy = false;
      }
    });
  }

  return {
    submit(input: TIn): void {
      // A pending (not-yet-drained) copy already sitting in `latest` when a
      // new one lands is the coalesce case — recorded before the overwrite
      // below so the count reflects what's actually discarded, not what
      // replaces it. Purely a metering read; the assignment/branch below is
      // unchanged from before instrumentation.
      const coalesced = busy && latest !== null;
      latest = opts.copy(input);
      workload.ingest("input");
      if (coalesced) workload.drop("coalesced");
      if (busy) return; // already scheduled/running — this frame coalesces in
      busy = true;
      setImmediate(() => runDrain(generation));
    },
    cancel(): void {
      if (latest !== null) workload.drop("cancelled");
      generation++;
      latest = null;
      busy = false;
    },
    get busy() {
      return busy;
    },
    dispose(): void {
      workload.dispose();
    },
  };
}
