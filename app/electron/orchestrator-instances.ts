// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Disposable per-app-instance lifecycle state machine (Electron-free — the
// fork/port/janitor wiring is INJECTED from main.ts, unit-tested with fakes).
// Owns: the typed instance table + ≤1-hardware gate; the hardware-clear GATE
// (withhold "hardware-clear" until the previous hardware instance is confirmed
// dead + swept, since Aravis acquisition must serialize even as a fresh instance
// forks while the previous one is still tearing down); death classification +
// janitor on every non-clean path.
// spec: docs/spec/windows.md#instances

import {
  classifyOrchestratorExit,
  shouldRunJanitor,
  type OrchestratorDownReport,
} from "./orchestrator-exit.js";

export type InstanceKind = "hardware" | "non-hardware";
/** Lifecycle phase. `live` = running (a hardware instance may still be waiting
 *  on hardware-clear); `draining` = shutdown requested, bounded wait for the
 *  quiesce ack; `dead` = process exited. */
export type InstancePhase = "live" | "draining" | "dead";

/** The orchestrator process handle the registry drives — main.ts adapts a real
 *  `utilityProcess` onto this; tests use fakes. */
export interface InstanceProc {
  /** `transfer` carries a MessagePort on the connect handshake; the registry
   *  itself never uses it (control messages only). */
  postMessage(message: unknown, transfer?: unknown[]): void;
  kill(): void;
  readonly pid?: number | undefined;
}

/** Read-only projection of an instance the injected deps receive. */
export interface InstanceView {
  readonly id: string;
  readonly kind: InstanceKind;
  readonly proc: InstanceProc;
  readonly phase: InstancePhase;
  /** Human session name (the activating app id, e.g. `manual-control`) — carried
   *  so a bound observer window (the profiler) can title itself with the session
   *  it pins to. Defaults to the instance id when no app id is supplied. */
  readonly sessionName: string;
  /** Hardware instances: has main sent "hardware-clear" (acquisition allowed)?
   *  Non-hardware instances are cleared at fork (they never touch hardware). */
  readonly hardwareCleared: boolean;
}

type TimerToken = ReturnType<typeof setTimeout>;

export interface InstanceRegistryDeps {
  /** Fork a fresh orchestrator process for this instance id + kind. */
  fork(id: string, kind: InstanceKind): InstanceProc;
  /** Grant hardware acquisition to a live instance (main → orchestrator
   *  "hardware-clear"): the orchestrator's acquisition gate opens. Emitted
   *  EXACTLY ONCE per instance, only when the ≤1-holder gate is satisfied. */
  sendHardwareClear(inst: InstanceView): void;
  /** Begin the bounded drain-and-quiesce (main → orchestrator "shutdown"): the
   *  orchestrator drains sessions, disarms hardware, posts the clean-exit ack,
   *  and idles for the reap. */
  sendShutdown(inst: InstanceView): void;
  /** Reap the instance process (SIGTERM). */
  kill(inst: InstanceView): void;
  /** Run the hardware janitor for a non-cleanly-dead instance (fresh process,
   *  disarms MEMS + stops cameras). Resolves when the sweep completes. */
  runJanitor(inst: InstanceView, reason: string): Promise<void>;
  /** Push a typed down report to the instance's owned windows (crash surface —
   *  scoped to the instance's windows). */
  notifyDown(inst: InstanceView, report: OrchestratorDownReport): void;
  /** Fires whenever a hardware orchestrator process becomes alive / all die —
   *  main pauses the enumerate-only probe while a hardware instance is alive so
   *  its `Camera.list()` never contends with the app's exclusive acquisition. */
  onHardwareAliveChange?(alive: boolean): void;
  /** Fires whenever the set of live orchestrator pids changes — main refreshes
   *  the crash-watchdog state file so it guards whichever instances are alive. */
  onLivePidsChange?(pids: number[]): void;
  /** Injectable timer (bounded quiesce), defaults to setTimeout/clearTimeout. */
  schedule?(fn: () => void, ms: number): TimerToken;
  cancel?(t: TimerToken): void;
  /** Bounded quiesce deadline (ms) before a kill (~3-5s). */
  quiesceMs?: number;
}

interface InstanceRec {
  id: string;
  kind: InstanceKind;
  proc: InstanceProc;
  phase: InstancePhase;
  sessionName: string;
  hardwareCleared: boolean;
  /** Clean-exit ack (`quiesced`) received before exit. */
  quiesced: boolean;
  /** Main initiated this instance's termination (switch/close/quit) — an
   *  ack-less exit then reads as "killed" (expected), not "crash". */
  expected: boolean;
  /** Janitor sweep for this instance's non-clean death completed. */
  janitorDone: boolean;
  /** Owned windows (windowIds). A hardware instance dies when its last
   *  owned window closes. */
  windows: Set<string>;
  /** Attached observer windows (windowIds) — the profiler pins here at
   *  open. Unlike owned `windows` these NEVER gate teardown (the profiler may
   *  outlive its instance), but they DO receive the down report and
   *  route their connect to this instance (never any other). */
  attachments: Set<string>;
  /** Set once the instance has ever owned a window — so a just-forked instance
   *  awaiting its window isn't torn down as "no windows". */
  hadWindow: boolean;
  drainTimer: TimerToken | null;
}

function view(rec: InstanceRec): InstanceView {
  return {
    id: rec.id,
    kind: rec.kind,
    proc: rec.proc,
    phase: rec.phase,
    sessionName: rec.sessionName,
    hardwareCleared: rec.hardwareCleared,
  };
}

/** A hardware instance no longer holds any hardware iff its process is dead AND
 *  it either acked a clean quiesce (released in-process) or its janitor swept. */
function hardwareReleased(rec: InstanceRec): boolean {
  return rec.phase === "dead" && (rec.quiesced || rec.janitorDone);
}

export class OrchestratorInstances {
  private readonly instances: InstanceRec[] = [];
  private idCounter = 0;
  private lastHardwareAlive = false;
  private readonly schedule: (fn: () => void, ms: number) => TimerToken;
  private readonly cancel: (t: TimerToken) => void;
  private readonly quiesceMs: number;

  constructor(private readonly deps: InstanceRegistryDeps) {
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.cancel ?? ((t) => clearTimeout(t));
    this.quiesceMs = deps.quiesceMs ?? 4000;
  }

  /** All non-dead instances (typed table snapshot, most-recent last). */
  live(): InstanceView[] {
    return this.instances.filter((r) => r.phase !== "dead").map(view);
  }

  /** The current live hardware instance (the newest one that isn't dead) — the
   *  connect/`window:closed` broker target + the switch's outgoing instance. */
  currentHardware(): InstanceView | null {
    for (let i = this.instances.length - 1; i >= 0; i--)
      if (this.instances[i].kind === "hardware" && this.instances[i].phase !== "dead")
        return view(this.instances[i]);
    return null;
  }

  /** Broker target for a fresh UNBOUND renderer connection (projection / debug).
   *  Prefers the current live app (hardware) instance so the window shares its
   *  stream graph. With no app instance, falls back to the newest live
   *  NON-hardware instance (a future viewer compute instance). Null when nothing
   *  is up. NOTE: the config store no longer routes here — it goes straight to
   *  MAIN, so config/TeleCanvas windows need no
   *  instance and main no longer forks a "settings" one. */
  connectTarget(): InstanceProc | null {
    const hw = this.currentHardware();
    if (hw) return hw.proc;
    for (let i = this.instances.length - 1; i >= 0; i--)
      if (this.instances[i].phase !== "dead") return this.instances[i].proc;
    return null;
  }

  /** True while a hardware orchestrator process is alive (main pauses the probe
   *  on this). */
  hardwareAlive(): boolean {
    return this.instances.some((r) => r.kind === "hardware" && r.phase !== "dead");
  }

  /** Pids of every live orchestrator process (watchdog state file). */
  livePids(): number[] {
    return this.instances
      .filter((r) => r.phase !== "dead" && typeof r.proc.pid === "number")
      .map((r) => r.proc.pid as number);
  }

  /** Any orchestrator process still alive (quit gate / watchdog stand-down). */
  anyAlive(): boolean {
    return this.instances.some((r) => r.phase !== "dead");
  }

  private byId(id: string): InstanceRec | undefined {
    return this.instances.find((r) => r.id === id);
  }

  /**
   * Fork a FRESH instance for an app activation. The previous hardware instance
   * (if any) must ALREADY be draining/dead — callers arrange the switch drain
   * first (main's `drainSessions`), then open the new one. A hardware instance
   * forks with acquisition DEFERRED; `tryGrantHardware` grants it once every
   * other hardware instance has fully released. Non-hardware instances are
   * cleared immediately (they never touch hardware).
   */
  open(kind: InstanceKind, sessionName?: string): InstanceView {
    const id = `${kind === "hardware" ? "hw" : "nh"}-${++this.idCounter}`;
    const proc = this.deps.fork(id, kind);
    const rec: InstanceRec = {
      id,
      kind,
      proc,
      phase: "live",
      sessionName: sessionName ?? id,
      hardwareCleared: false,
      quiesced: false,
      expected: false,
      janitorDone: false,
      windows: new Set(),
      attachments: new Set(),
      hadWindow: false,
      drainTimer: null,
    };
    this.instances.push(rec);
    if (kind === "non-hardware") {
      rec.hardwareCleared = true;
      this.deps.sendHardwareClear(view(rec));
    } else {
      this.tryGrantHardware();
    }
    this.emitAlive();
    this.emitPids();
    return view(rec);
  }

  /** Associate an owned window (windowId) with an instance. */
  claimWindow(id: string, windowId: string): void {
    const rec = this.byId(id);
    if (!rec) return;
    rec.windows.add(windowId);
    rec.hadWindow = true;
  }

  /** The instance owning a window (for the `window:closed` broker + crash
   *  scoping), or null. */
  instanceForWindow(windowId: string): InstanceView | null {
    const rec = this.instances.find((r) => r.windows.has(windowId));
    return rec ? view(rec) : null;
  }

  /** Attach an OBSERVER window (the profiler) to an instance at open — the
   *  immutable per-instance binding. Unlike `claimWindow` this
   *  never marks `hadWindow` and never gates teardown: the profiler may outlive
   *  the instance. No-op if the instance is unknown. */
  attachWindow(id: string, windowId: string): void {
    this.byId(id)?.attachments.add(windowId);
  }

  /** The observer windowIds attached to an instance — a down report reaches
   *  these in ADDITION to its owned windows (the profiler's frozen banner). */
  attachmentsOf(id: string): string[] {
    return [...(this.byId(id)?.attachments ?? [])];
  }

  /** The instance a window is BOUND to — owned (app) or attached (profiler) —
   *  regardless of its phase, so the connect broker can fail CLOSED against a
   *  DEAD binding instead of falling back to another instance (the profiler's
   *  "never connect to another session" rule). Null only for an UNBOUND window
   *  (projection/debug), which the broker routes to the current instance. */
  boundInstance(windowId: string): InstanceView | null {
    const rec = this.instances.find(
      (r) => r.windows.has(windowId) || r.attachments.has(windowId),
    );
    return rec ? view(rec) : null;
  }

  /** The windowIds an instance currently owns — the crash-report scope: a down
   *  report reaches ONLY this instance's windows, so a NEW instance's
   *  app window never reacts to the OLD instance's death. */
  windowsOf(id: string): string[] {
    return [...(this.byId(id)?.windows ?? [])];
  }

  /** A window closed: drop it, and dispose its instance once its LAST owned
   *  window is gone (app close → welcome, or the outgoing side of a switch). */
  onWindowClosed(windowId: string): void {
    // Drop any observer binding first (profiler close) — this never affects an
    // instance's lifecycle, so it can't tear anything down.
    for (const r of this.instances) r.attachments.delete(windowId);
    const rec = this.instances.find((r) => r.windows.has(windowId));
    if (!rec) return;
    rec.windows.delete(windowId);
    if (rec.hadWindow && rec.windows.size === 0 && rec.phase === "live")
      this.teardown(rec.id, "app window closed");
  }

  /**
   * Begin the bounded drain-and-quiesce of one instance: send `shutdown`, arm
   * the deadline. On the ack (`onAck`) main reaps it cleanly; on the deadline
   * we kill + janitor. Idempotent (a second call while already draining/dead is
   * a no-op).
   */
  teardown(id: string, reason: string): void {
    const rec = this.byId(id);
    if (!rec || rec.phase !== "live") return;
    rec.phase = "draining";
    rec.expected = true;
    this.deps.sendShutdown(view(rec));
    rec.drainTimer = this.schedule(() => {
      rec.drainTimer = null;
      // The quiesce wedged — kill it (its exit handler runs the janitor since
      // no clean-exit ack arrived). Teardown errors die with the process.
      if (rec.phase === "draining") this.deps.kill(view(rec));
    }, this.quiesceMs);
    void reason;
  }

  /** Begin teardown of EVERY live instance (full quit) — bounded per instance. */
  teardownAll(reason: string): void {
    for (const rec of this.instances)
      if (rec.phase === "live") this.teardown(rec.id, reason);
  }

  /** The instance posted its clean-exit ack (`quiesced`). If it was draining,
   *  reap it now — main has the authoritative clean signal. */
  onAck(id: string): void {
    const rec = this.byId(id);
    if (!rec) return;
    rec.quiesced = true;
    if (rec.phase === "draining") {
      if (rec.drainTimer !== null) {
        this.cancel(rec.drainTimer);
        rec.drainTimer = null;
      }
      this.deps.kill(view(rec));
    }
  }

  /** The instance process exited. Classify (ack-based, never exit-code
   *  guessing), janitor on every non-clean path, surface the report to owned
   *  windows, then re-attempt the hardware-clear gate for any waiter. */
  onExit(id: string, code: number | null): void {
    const rec = this.byId(id);
    if (!rec || rec.phase === "dead") return;
    if (rec.drainTimer !== null) {
      this.cancel(rec.drainTimer);
      rec.drainTimer = null;
    }
    rec.phase = "dead";
    const report = classifyOrchestratorExit({
      acked: rec.quiesced,
      expected: rec.expected,
      code,
    });
    this.deps.notifyDown(view(rec), report);
    if (shouldRunJanitor(report)) {
      void this.deps
        .runJanitor(view(rec), `${rec.id} ${report.reason} (code ${code})`)
        .finally(() => {
          rec.janitorDone = true;
          this.tryGrantHardware();
        });
    }
    this.tryGrantHardware();
    this.emitAlive();
    this.emitPids();
  }

  /** Grant hardware-clear to the single waiting hardware instance once every
   *  OTHER hardware instance has fully released hardware (dead + acked/swept).
   *  The ≤1-holder gate: at most one hardware instance is ever cleared. */
  private tryGrantHardware(): void {
    for (const rec of this.instances) {
      if (rec.kind !== "hardware" || rec.hardwareCleared || rec.phase !== "live")
        continue;
      const blocked = this.instances.some(
        (o) => o !== rec && o.kind === "hardware" && !hardwareReleased(o),
      );
      if (blocked) continue;
      rec.hardwareCleared = true;
      this.deps.sendHardwareClear(view(rec));
    }
  }

  private emitAlive(): void {
    const alive = this.hardwareAlive();
    if (alive !== this.lastHardwareAlive) {
      this.lastHardwareAlive = alive;
      this.deps.onHardwareAliveChange?.(alive);
    }
  }

  private emitPids(): void {
    this.deps.onLivePidsChange?.(this.livePids());
  }
}
