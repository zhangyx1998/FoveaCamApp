// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Projection split-view — per-pane termination / rebind state machine. Orchestrators
// are disposable per-app, so a pane whose source is lost freezes (dismissible cover)
// rather than terminating: live→frozen→(live on rebind | terminated after ~GRACE_MS).
// The window auto-closes only when EVERY pane is terminated and projection_auto_close
// is on. Pure + timer-injectable (fake-timer tests); Vue-free.
// spec: docs/spec/projection.md#termination

/** Grace window (ms) a lost source has to reappear before the pane is counted
 *  TERMINATED (for auto-close). ~10 s per the planner decision — long enough to
 *  ride out an app switch's orchestrator handoff, short enough that a genuinely
 *  dead window auto-closes promptly. Param'd on the machine for tests/tuning. */
export const DEFAULT_GRACE_MS = 10_000;

export type PaneLifecycle = "live" | "frozen" | "terminated";

export type TerminationSnapshot = {
  status: PaneLifecycle;
  /** Show the "source has closed" cover? True only while frozen AND undismissed. */
  coverVisible: boolean;
};

/** Injectable timer surface (defaults to globals; tests pass fakes or use
 *  vitest's fake timers, which patch the globals). */
export type TimerHost = {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: TimerHost = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type TerminationOptions = {
  graceMs?: number;
  timers?: TimerHost;
  /** Called whenever the snapshot changes (status or cover) — the pane wires
   *  this to update its reactive refs / trigger the window's auto-close check. */
  onChange?: (snap: TerminationSnapshot) => void;
};

/**
 * One pane's termination machine. The pane feeds it source lifecycle events;
 * it exposes the current `snapshot()` and fires `onChange` on any transition.
 */
export class TerminationMachine {
  private status: PaneLifecycle = "live";
  private dismissed = false;
  private timer: unknown = null;
  private readonly graceMs: number;
  private readonly timers: TimerHost;
  private readonly onChange?: (snap: TerminationSnapshot) => void;

  constructor(opts: TerminationOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.timers = opts.timers ?? defaultTimers;
    this.onChange = opts.onChange;
  }

  snapshot(): TerminationSnapshot {
    return {
      status: this.status,
      coverVisible: this.status === "frozen" && !this.dismissed,
    };
  }

  /** The source stopped delivering (channel death, orchestratorDown, pipe
   *  un-advertise). Freezes the last frame and arms the grace timer. Idempotent
   *  while already frozen (the timer is NOT restarted). No effect once
   *  terminated (a dead pane stays dead until an explicit rebind). */
  sourceLost(): void {
    if (this.status === "frozen") return;
    if (this.status === "terminated") return; // rebind is the only way out
    this.status = "frozen";
    this.dismissed = false;
    this.arm();
    this.emit();
  }

  /** The source came back (a new orchestrator instance connected, or the pipe
   *  advert reappeared with a bumped epoch). Rebinds the pane to LIVE from
   *  either frozen or terminated, cancels the grace timer, and re-shows a
   *  future cover. A no-op when already live. */
  sourceReturned(): void {
    if (this.status === "live") return;
    this.disarm();
    this.status = "live";
    this.dismissed = false;
    this.emit();
  }

  /** Dismiss the cover — keeps the frozen frame and the running grace timer;
   *  only hides the note. No effect unless a cover is currently visible. */
  dismissCover(): void {
    if (this.status !== "frozen" || this.dismissed) return;
    this.dismissed = true;
    this.emit();
  }

  /** Is this pane terminated (counts toward the window's auto-close check)? */
  get terminated(): boolean {
    return this.status === "terminated";
  }

  /** Tear down the timer (pane unmount / window close). */
  dispose(): void {
    this.disarm();
  }

  private arm(): void {
    this.disarm();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      // Grace elapsed with no rebind — the source is gone for good.
      if (this.status === "frozen") {
        this.status = "terminated";
        this.emit();
      }
    }, this.graceMs);
  }

  private disarm(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private emit(): void {
    this.onChange?.(this.snapshot());
  }
}

/** Do ALL panes count as terminated? (Empty set → false: an empty window is
 *  handled by the "last pane removed" path, not the termination path.) */
export function allTerminated(statuses: PaneLifecycle[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === "terminated");
}
