// Disposable-orchestrator instance registry. The Electron fork/port/janitor
// wiring is injected, so the state machine is the testable core:
//   • fork/ack/timeout/kill transitions
//   • the ≤1-hardware-holder gate (hardware-clear withheld until the previous
//     hardware instance is confirmed dead + swept)
//   • hardware-clear emission ordering
//   • janitor on every non-clean death path; clean death skips it
// Modeled on viewer-engine.test.ts (injected-wiring manager with fake timers).

import { describe, expect, it, vi } from "vitest";
import {
  OrchestratorInstances,
  type InstanceProc,
  type InstanceRegistryDeps,
  type InstanceView,
} from "../electron/orchestrator-instances";

/** A synchronous fake timer: `schedule` returns a token; `fire(token)` runs it. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    schedule: (fn: () => void) => {
      const id = ++seq;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (t: ReturnType<typeof setTimeout>) => pending.delete(t as unknown as number),
    fire: (t: number) => {
      const fn = pending.get(t);
      pending.delete(t);
      fn?.();
    },
    pendingCount: () => pending.size,
  };
}

type Harness = {
  reg: OrchestratorInstances;
  events: string[];
  procs: Map<string, FakeProc>;
  janitorResolvers: Array<() => void>;
  timers: ReturnType<typeof fakeTimers>;
};

interface FakeProc extends InstanceProc {
  pid: number;
}

function harness(quiesceMs = 4000): Harness {
  const events: string[] = [];
  const procs = new Map<string, FakeProc>();
  const janitorResolvers: Array<() => void> = [];
  const timers = fakeTimers();
  let pid = 100;
  const deps: InstanceRegistryDeps = {
    fork: (id, kind) => {
      events.push(`fork:${id}:${kind}`);
      const proc: FakeProc = { pid: ++pid, postMessage: () => {}, kill: () => {} };
      procs.set(id, proc);
      return proc;
    },
    sendHardwareClear: (inst: InstanceView) => events.push(`clear:${inst.id}`),
    sendShutdown: (inst: InstanceView) => events.push(`shutdown:${inst.id}`),
    kill: (inst: InstanceView) => events.push(`kill:${inst.id}`),
    runJanitor: (inst: InstanceView, reason: string) => {
      events.push(`janitor:${inst.id}`);
      void reason;
      return new Promise<void>((r) => janitorResolvers.push(r));
    },
    notifyDown: (inst: InstanceView, report) => events.push(`down:${inst.id}:${report.reason}`),
    onHardwareAliveChange: (alive) => events.push(`alive:${alive}`),
    schedule: timers.schedule,
    cancel: timers.cancel,
    quiesceMs,
  };
  return { reg: new OrchestratorInstances(deps), events, procs, janitorResolvers, timers };
}

describe("OrchestratorInstances — fork + hardware-clear", () => {
  it("forks and clears the first hardware instance immediately (no prior holder)", () => {
    const h = harness();
    const inst = h.reg.open("hardware");
    expect(inst.kind).toBe("hardware");
    expect(h.events).toEqual(["fork:hw-1:hardware", "clear:hw-1", "alive:true"]);
  });

  it("clears a non-hardware instance immediately (never gates on hardware)", () => {
    const h = harness();
    h.reg.open("non-hardware");
    // Non-hardware forks + clears; it does NOT flip hardware-alive.
    expect(h.events).toEqual(["fork:nh-1:non-hardware", "clear:nh-1"]);
    expect(h.reg.hardwareAlive()).toBe(false);
  });
});

describe("OrchestratorInstances — ≤1-hardware gate + hardware-clear ordering", () => {
  it("withholds hardware-clear from the new instance until the old one is DEAD + swept", () => {
    const h = harness();
    const a = h.reg.open("hardware"); // hw-1 cleared immediately
    h.reg.claimWindow(a.id, "app-1");
    h.events.length = 0;

    // Switch: outgoing drains, new instance forks (deferred).
    h.reg.teardown(a.id, "switch");
    const b = h.reg.open("hardware");
    h.reg.claimWindow(b.id, "app-2");
    // b forked but NOT cleared — hw-1 still draining (holds hardware).
    expect(h.events).toEqual(["shutdown:hw-1", "fork:hw-2:hardware"]);
    expect(b.hardwareCleared).toBe(false);

    // hw-1 acks the clean quiesce → main kills it.
    h.reg.onAck(a.id);
    expect(h.events).toContain("kill:hw-1");
    // Still not cleared — process hasn't exited yet.
    expect(h.reg.currentHardware()?.id).toBe("hw-2");

    // hw-1 exits CLEAN (acked) → no janitor → hardware released → b cleared.
    h.reg.onExit(a.id, 0);
    expect(h.events).toContain("down:hw-1:clean");
    expect(h.events).toContain("clear:hw-2");
    expect(h.events).not.toContain("janitor:hw-1");
  });

  it("defers hardware-clear across a janitor sweep on an unclean death", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.claimWindow(a.id, "app-1");
    h.reg.teardown(a.id, "switch");
    const b = h.reg.open("hardware");
    h.events.length = 0;

    // hw-1 dies WITHOUT an ack (timeout kill) → janitor runs → b still deferred.
    h.timers.fire(1); // quiesce deadline → kill hw-1
    expect(h.events).toContain("kill:hw-1");
    h.reg.onExit(a.id, 15);
    expect(h.events).toContain("down:hw-1:killed");
    expect(h.events).toContain("janitor:hw-1");
    expect(h.events).not.toContain("clear:hw-2"); // sweep not done yet
    expect(b.hardwareCleared).toBe(false);

    // Janitor sweep completes → NOW b may acquire.
    h.janitorResolvers[0]();
    return Promise.resolve().then(() => {
      expect(h.events).toContain("clear:hw-2");
    });
  });
});

describe("OrchestratorInstances — teardown transitions", () => {
  it("acks before the deadline: cancels the timer, kills, classifies clean", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.teardown(a.id, "close");
    expect(h.timers.pendingCount()).toBe(1);
    h.reg.onAck(a.id);
    expect(h.timers.pendingCount()).toBe(0); // grace cancelled
    h.reg.onExit(a.id, 0);
    expect(h.events.filter((e) => e.startsWith("down:"))).toEqual(["down:hw-1:clean"]);
  });

  it("times out with no ack: kills + janitors + classifies killed", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.teardown(a.id, "close");
    h.timers.fire(1);
    expect(h.events).toContain("kill:hw-1");
    h.reg.onExit(a.id, null);
    expect(h.events).toContain("down:hw-1:killed");
    expect(h.events).toContain("janitor:hw-1");
  });

  it("an unexpected exit (no teardown) classifies crash + janitors", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.events.length = 0;
    h.reg.onExit(a.id, 6); // native fault, never asked to stop
    expect(h.events).toContain("down:hw-1:crash");
    expect(h.events).toContain("janitor:hw-1");
    expect(h.events).toContain("alive:false");
  });

  it("teardown is idempotent and inert on a dead instance", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.teardown(a.id, "close");
    h.reg.onExit(a.id, 0);
    h.events.length = 0;
    h.reg.teardown(a.id, "again");
    expect(h.events).toEqual([]);
  });
});

describe("OrchestratorInstances — window ownership", () => {
  it("disposes an instance when its last owned window closes", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.claimWindow(a.id, "app-1");
    h.events.length = 0;
    h.reg.onWindowClosed("app-1");
    expect(h.events).toContain("shutdown:hw-1"); // begins drain-and-quiesce
  });

  it("does NOT tear down a just-forked instance that has no window yet", () => {
    const h = harness();
    h.reg.open("hardware"); // no claimWindow
    h.events.length = 0;
    h.reg.onWindowClosed("app-1"); // unrelated / stale
    expect(h.events).toEqual([]);
  });

  it("maps windows to instances for brokering + crash scoping", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.claimWindow(a.id, "app-1");
    expect(h.reg.instanceForWindow("app-1")?.id).toBe("hw-1");
    expect(h.reg.instanceForWindow("nope")).toBeNull();
  });
});

describe("OrchestratorInstances — profiler per-instance binding", () => {
  it("carries a human session name (the app id) on the instance view", () => {
    const h = harness();
    const a = h.reg.open("hardware", "manual-control");
    expect(a.sessionName).toBe("manual-control");
    // Defaults to the id when no name is supplied (unbound / non-hardware).
    expect(h.reg.open("non-hardware").sessionName).toBe("nh-2");
  });

  it("attaches an observer window and resolves it via boundInstance (even dead)", () => {
    const h = harness();
    const a = h.reg.open("hardware", "manual-control");
    h.reg.attachWindow(a.id, "profiler-1");
    expect(h.reg.boundInstance("profiler-1")?.id).toBe("hw-1");
    expect(h.reg.attachmentsOf(a.id)).toEqual(["profiler-1"]);
    // instanceForWindow is OWNED-only: an attachment is not an owned window.
    expect(h.reg.instanceForWindow("profiler-1")).toBeNull();

    // Instance dies — boundInstance STILL resolves it (dead), so the connect
    // broker can fail closed instead of routing to another instance.
    h.reg.onExit(a.id, 6);
    const bound = h.reg.boundInstance("profiler-1");
    expect(bound?.id).toBe("hw-1");
    expect(bound?.phase).toBe("dead");
  });

  it("resolves an OWNED app window via boundInstance too; unknown → null", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.claimWindow(a.id, "app-1");
    expect(h.reg.boundInstance("app-1")?.id).toBe("hw-1");
    expect(h.reg.boundInstance("nope")).toBeNull();
  });

  it("an attached profiler NEVER gates teardown (it may outlive the instance)", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.claimWindow(a.id, "app-1");
    h.reg.attachWindow(a.id, "profiler-1");
    h.events.length = 0;
    // Closing the profiler leaves the app window owning the instance → no drain.
    h.reg.onWindowClosed("profiler-1");
    expect(h.events).toEqual([]);
    expect(h.reg.boundInstance("profiler-1")).toBeNull(); // detached
    // The owned app window still disposes it.
    h.reg.onWindowClosed("app-1");
    expect(h.events).toContain("shutdown:hw-1");
  });
});

describe("OrchestratorInstances — liveness signals", () => {
  it("reports live pids and hardware-alive for the watchdog + probe", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    expect(h.reg.hardwareAlive()).toBe(true);
    expect(h.reg.livePids().length).toBe(1);
    h.reg.teardown(a.id, "quit");
    h.reg.onExit(a.id, 0);
    expect(h.reg.hardwareAlive()).toBe(false);
    expect(h.reg.anyAlive()).toBe(false);
    expect(h.reg.livePids()).toEqual([]);
  });

  it("connectTarget / currentHardware follow the newest live instance", () => {
    const h = harness();
    const a = h.reg.open("hardware");
    h.reg.teardown(a.id, "switch");
    const b = h.reg.open("hardware");
    expect(h.reg.currentHardware()?.id).toBe(b.id);
    expect(h.reg.connectTarget()).toBe(b.proc);
  });
});
