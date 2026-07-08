// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Resource-scoped session lifecycle (A-P1). Each activation gets a
// `ResourceScope` that OWNS the cleanups registered during `activate` and
// drains them LIFO on idle. The scope also enforces the two lifecycle
// invariants that produced a recurring bug class in the hand-rolled sessions:
//
//   1. **Ordered async drain** (V1/RT1): `idle()` returns a promise that
//      resolves only after every registered cleanup — including camera-lease
//      releases and async drains — has run, LIFO. The runtime's `drained()`
//      awaits it, so a window switch waits for the real teardown.
//   2. **Stale-async-completion safety** (V5/V10): if the session idles (or
//      re-activates) while a slow `activate` is still running, that activation
//      is SUPERSEDED — every resource it acquires from then on is released
//      immediately instead of leaking, and a re-activation serializes behind
//      the prior drain so two activations never hold the leases at once.
//
// Built on the A-R2-P1 `session-resources` primitives (DisposerBag/releaseLeases
// are still used inside `activate`); this adds the generation/drain machinery
// around them. Additive: `defineResourceSession` sits alongside `defineSession`,
// so sessions migrate one at a time.

import { defineSession, type ServerSession, type SessionDefinition } from "./runtime.js";
import type { Contract } from "@lib/orchestrator/protocol";
import type { Disposer } from "./session-resources.js";
import { report } from "./diagnostics.js";

/** One activation's resource scope — see the module header. Passed to
 *  `activate`; the session registers every cleanup on it. */
export interface ResourceScope {
  /** True once this activation has been superseded (the session idled or
   *  re-activated since it began). `activate` MUST bail after any `await` where
   *  this is true — the resources it would create are no longer wanted. */
  readonly cancelled: boolean;
  /** Register a cleanup (sync or async); runs LIFO on drain. If the scope is
   *  already draining/cancelled, the cleanup runs immediately so a
   *  late-registered resource can't leak. */
  defer(cleanup: () => void | Promise<void>): void;
  /** DisposerBag-compatible sync alias — lets `bindViews`/`bindDetections`
   *  register their unsubscribers straight onto the scope. */
  add(disposer: Disposer): Disposer;
  push(...disposers: Disposer[]): void;
  /** Acquire a resource and auto-register its release. Returns null (and
   *  releases immediately) if the activation was superseded during
   *  acquisition, so the caller can bail without leaking the resource. */
  use<T>(
    acquire: () => T | Promise<T>,
    release: (r: T) => void | Promise<void>,
  ): Promise<T | null>;
}

class Scope implements ResourceScope {
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private draining = false;

  constructor(private readonly superseded: () => boolean) {}

  get cancelled(): boolean {
    return this.draining || this.superseded();
  }

  defer(cleanup: () => void | Promise<void>): void {
    if (this.cancelled) {
      void Promise.resolve().then(cleanup).catch(() => {});
      return;
    }
    this.cleanups.push(cleanup);
  }

  add(disposer: Disposer): Disposer {
    this.defer(disposer);
    return disposer;
  }

  push(...disposers: Disposer[]): void {
    for (const d of disposers) this.defer(d);
  }

  async use<T>(
    acquire: () => T | Promise<T>,
    release: (r: T) => void | Promise<void>,
  ): Promise<T | null> {
    const r = await acquire();
    if (this.cancelled) {
      await release(r);
      return null;
    }
    this.defer(() => release(r));
    return r;
  }

  /** Run every registered cleanup, LIFO, awaiting async ones. Idempotent — a
   *  second call (e.g. the trailing self-drain of a superseded activate after
   *  idle already drained) is a no-op. Once draining, further `defer`s run
   *  immediately (see `cancelled`), so the cleanup list can't grow here. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    const cleanups = this.cleanups.splice(0).reverse();
    for (const c of cleanups) {
      try {
        await c();
      } catch {
        // Swallow — one bad cleanup must not wedge the rest of the drain.
      }
    }
  }
}

/** Declarative shape for a resource-scoped session — like `SessionDefinition`
 *  but `activate` receives the scope and `idle` is just optional post-drain
 *  work (the scope drain is automatic). */
export interface ResourceSessionDefinition<C extends Contract> {
  /** (Re)start session-owned resources. Register every cleanup on `scope`.
   *  Bail after any `await` where `scope.cancelled` is true. */
  activate(scope: ResourceScope, s: ServerSession<C>): void | Promise<void>;
  /** Optional work AFTER the scope has fully drained (e.g. `resetTelemetry`).
   *  Leases/loops are already released by the time this runs. */
  idle?(s: ServerSession<C>): void | Promise<void>;
  busy?(): string | null;
  commands: SessionDefinition<C>["commands"];
  watch?: SessionDefinition<C>["watch"];
}

export function defineResourceSession<C extends Contract>(
  name: string,
  contract: C,
  build: (s: ServerSession<C>) => ResourceSessionDefinition<C>,
): ServerSession<C> {
  return defineSession(name, contract, (s) => {
    const def = build(s);
    // Monotonic activation counter — bumped on every activate AND idle, so a
    // captured `gen` stops matching the instant its activation is superseded.
    let generation = 0;
    let scope: Scope | null = null;
    // The previous idle's drain; the next activate serializes behind it so two
    // activations never overlap on the shared leases.
    let lastDrain: Promise<void> = Promise.resolve();

    function activate(): void {
      const gen = ++generation;
      const prev = lastDrain;
      void (async () => {
        await prev; // wait out the previous idle's drain (V1/RT1)
        if (gen !== generation) return; // superseded before we even started
        const sc = new Scope(() => gen !== generation);
        scope = sc;
        try {
          await def.activate(sc, s);
        } catch (e) {
          report(name, `activate: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Superseded mid-activate → drain whatever we set up (V5/V10). If idle
        // already drained this scope, `drain()` is a no-op.
        if (sc.cancelled) await sc.drain();
      })();
    }

    function idle(): Promise<void> {
      const sc = scope;
      scope = null;
      generation++; // supersede any in-flight activation
      lastDrain = (async () => {
        if (sc) await sc.drain();
        await def.idle?.(s);
      })();
      return lastDrain;
    }

    return {
      commands: def.commands,
      watch: def.watch,
      activate,
      idle,
      busy: def.busy,
    };
  });
}
