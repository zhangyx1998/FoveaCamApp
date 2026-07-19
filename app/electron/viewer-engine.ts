// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer-engine lifecycle bookkeeping (per-window utilityProcess map; the
// Electron fork/port wiring is INJECTED via `create`, unit-tested). Invariants:
// single-writer sidecar (one engine per `.fcap`, keyed per window),
// terminate-before-respawn (flush+kill the old engine before forking the new),
// flush-before-close (bounded grace on the `flushed` ack so quit never hangs).
// spec: docs/spec/viewer.md#topology

/** A live viewer engine, as the manager sees it — the Electron process wiring
 *  (fork, MessageChannelMain, port delivery, crash push) is hidden behind this
 *  by `create`. */
export interface EngineHandle {
  /** Ask the engine to flush its pending sidecar write. Resolves when the
   *  engine acks (`flushed`) — or immediately if it is already gone. */
  requestFlush(): Promise<void>;
  /** Terminate the engine process (idempotent). */
  kill(): void;
}

export interface ViewerEngineDeps {
  /** Fork + wire a fresh engine for `key`'s window over `file`. */
  create(key: number, file: string): EngineHandle;
  /** Bounded flush grace before a kill (ms). */
  graceMs: number;
  /** Injectable timer for tests (defaults to `setTimeout`/`clearTimeout`). */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (t: ReturnType<typeof setTimeout>) => void;
}

/** Race the engine's flush ack against a bounded grace, then kill it
 *  unconditionally. Exported for direct unit coverage. */
export function flushWithGrace(
  handle: EngineHandle,
  graceMs: number,
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) =>
    setTimeout(fn, ms),
  cancel: (t: ReturnType<typeof setTimeout>) => void = (t) => clearTimeout(t),
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cancel(timer);
      resolve();
    };
    const timer = schedule(finish, graceMs);
    // Either the ack or the deadline releases the grace; a flush rejection is
    // treated as "done" (nothing more we can do but kill).
    handle.requestFlush().then(finish, finish);
  }).then(() => handle.kill());
}

/** Per-window viewer-engine map + lifecycle sequencing. */
export class ViewerEngineManager {
  private engines = new Map<number, EngineHandle>();
  private inflight = new Set<Promise<void>>();

  constructor(private readonly deps: ViewerEngineDeps) {}

  /** (Re)spawn the engine for one viewer window. Terminate-before-respawn: any
   *  existing engine for this window is flushed + killed FIRST, so the new one
   *  never shares the sidecar with a stale writer. */
  async spawn(key: number, file: string): Promise<void> {
    await this.terminate(key);
    this.engines.set(key, this.deps.create(key, file));
  }

  /** Window closed: flush (bounded) then kill the engine, if any. */
  close(key: number): Promise<void> {
    return this.terminate(key);
  }

  /** The engine exited on its OWN (crash) — drop the handle without flushing or
   *  killing an already-dead process. */
  forget(key: number): void {
    this.engines.delete(key);
  }

  /** True while an engine is registered for this window. */
  has(key: number): boolean {
    return this.engines.has(key);
  }

  /** Flush + kill every engine (app quit) and await the bounded grace. */
  async killAll(): Promise<void> {
    await Promise.all([...this.engines.keys()].map((k) => this.terminate(k)));
    await this.settle();
  }

  /** Await all in-flight flush-grace terminations (a bound for quit). */
  async settle(): Promise<void> {
    await Promise.all([...this.inflight]);
  }

  private terminate(key: number): Promise<void> {
    const handle = this.engines.get(key);
    if (!handle) return Promise.resolve();
    this.engines.delete(key); // claim it before the async grace (idempotent)
    const p = flushWithGrace(
      handle,
      this.deps.graceMs,
      this.deps.schedule,
      this.deps.cancel,
    ).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }
}
