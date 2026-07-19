// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side orchestrator client. Wraps the RPC Channel in Vue's reactive shape so
// modules read/write authoritative orchestrator state as if it were local: state
// (reactive mutable, set = command, tracks the server echo), telemetry (reactive
// readonly), frame(name) (readonly Ref, latest-wins, coalesced to one rAF), call(name,
// arg) (Promise). The renderer holds only echoes, so windows stay consistent for free.
// spec: docs/spec/orchestrator-protocol.md#client

import {
  computed,
  customRef,
  onScopeDispose,
  reactive,
  readonly,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
  type WritableComputedRef,
} from "vue";
import type { Mat } from "core/Vision";
import { RollingStats, startLoopLagProbe } from "@lib/util/rolling";
import { inspectorMode } from "@lib/util/perf";
import type { PaneSource } from "@lib/projection/descriptor";
import {
  Channel,
  topic,
  type CommandsOf,
  type Contract,
  type Endpoint,
  type FramePayload,
  type FrameOf,
  type FrameTimingStats,
  type SessionStatus,
  type StateOf,
  type TelemetryOf,
} from "./protocol.js";
import { createShmClient } from "./shm-client.js";
import { pipes, type PipeHandle } from "./pipe-contract.js";
import {
  createPipeConsumer,
  type PipeConsumer,
  type PipeReaderIO,
} from "./pipe-consumer.js";
import { formatCounterRate, formatSampleStats } from "./stats.js";
import { controller } from "./contracts.js";
import type { Span } from "./contracts.js";
import {
  PID_OVERRIDE_KEYS,
  type PidOverrideCommand,
  type PidOverrideState,
} from "./pid-override-contract.js";

/** Rebuild the Mat shape (`FrameView`/vision ops expect) from a frame payload.
 *  The view is LENGTH-BOUNDED to the payload's shape — pool buffers are sized
 *  to the pipe's max footprint (slot bytes), so `p.data` may be larger
 *  than the active frame; a whole-buffer view would fail `new ImageData`'s
 *  exact-length check downstream. */
export function payloadToMat(p: FramePayload | null): Mat<Uint8Array> | null {
  if (!p?.data) return null;
  const [h = 0, w = 0] = p.shape;
  const bytes = h * w * p.channels;
  return Object.assign(
    new Uint8Array(p.data, 0, Math.min(bytes, p.data.byteLength)),
    {
      shape: p.shape,
      channels: p.channels,
    },
  ) as unknown as Mat<Uint8Array>;
}

// Renderer SHM transfer pool — the ping-pong buffer pool, port handshake,
// timeout, and message protocol with the preload live in their own module.
// Module-scope singleton: one pool per renderer window (the display path calls
// `shm.read()` in the frame flush and `shm.release()` when a materialized
// frame is displaced).
const shm = createShmClient();

/** Observe-only snapshot of the renderer SHM transfer pool: read
 *  outcomes (ok/null/timeout/error), buffer pool alloc/reuse, in-flight
 *  count, and round-trip latency. Read by the StreamView SHM OSD and folded
 *  into `dumpPerfSnapshot` under `renderer.shmReads`. Meters observe only —
 *  reading this never affects the read path. */
export function shmReadStats(): ReturnType<ReturnType<typeof createShmClient>["stats"]> {
  return shm.stats();
}

function domEndpoint(port: MessagePort): Endpoint {
  return {
    post: (data, transfer) => port.postMessage(data, transfer ?? []),
    onMessage: (cb) => {
      port.onmessage = (e) => cb(e.data);
    },
    close: () => port.close(),
  };
}

// ---- Renderer error tray ---------------------------------------------------
// Process-wide diagnostics (`topic.error`), fire-and-forget command rejections,
// and orchestrator-side `report()`s land in a bounded, dismissible ring the
// `ErrorTray.vue` chrome renders (otherwise they dead-end at `console.error`,
// invisible in a packaged app). Reactive + module-scope singleton (one tray
// per renderer window), same pattern as `orchestratorSpans` below.
export type ErrorReport = {
  scope: string;
  message: string;
  /** "error" = a failure EVENT (danger identity; rows coalesce on exact
   *  scope+message). "warning" = a degraded STATE (warn identity; ONE row per
   *  scope whose message tracks the latest report — a flapping condition,
   *  e.g. trigger-sync retrying with varying reasons, updates in place
   *  instead of flooding the ring). */
  level: "error" | "warning";
  /** Coalescing count (retry storms don't flood). */
  count: number;
  /** First + most-recent occurrence (`Date.now()`). */
  firstAt: number;
  lastAt: number;
};
const ERROR_TRAY_CAPACITY = 50;
/** Newest-first ring of recent error reports. Read by `ErrorTray.vue`. */
export const errorTray = reactive<ErrorReport[]>([]);

/** Push a report into the tray, coalescing an exact scope+message repeat into a
 *  count bump (moved to the front) so a retrying failure counts up instead of
 *  spamming the ring. Bounded to `ERROR_TRAY_CAPACITY`. */
export function reportToTray(
  scope: string,
  message: string,
  level: ErrorReport["level"] = "error",
): void {
  const at = Date.now();
  // Warnings coalesce by SCOPE (state — the message updates in place); errors
  // coalesce on the exact scope+message (events). See `ErrorReport.level`.
  const existing = errorTray.findIndex((r) =>
    level === "warning"
      ? r.scope === scope && r.level === "warning"
      : r.scope === scope && r.message === message && r.level === "error",
  );
  if (existing >= 0) {
    const [r] = errorTray.splice(existing, 1);
    r.message = message;
    r.count++;
    r.lastAt = at;
    errorTray.unshift(r);
    return;
  }
  errorTray.unshift({ scope, message, level, count: 1, firstAt: at, lastAt: at });
  if (errorTray.length > ERROR_TRAY_CAPACITY) errorTray.pop();
}

/** Remove one report from the tray (the `×` on a row). */
export function dismissError(report: ErrorReport): void {
  const i = errorTray.indexOf(report);
  if (i >= 0) errorTray.splice(i, 1);
}

/** Clear the whole tray (the header "Clear" action). */
export function clearErrors(): void {
  errorTray.splice(0);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let channel: Promise<Channel> | null = null;

// Live boot/activation/connect timing feed — bounded ring, module-scope
// singleton like `rendererLoopLag` below, so a profiler window can render a
// timeline without polling `perfSnapshot`.
const SPAN_RING_CAPACITY = 200;
export const orchestratorSpans: Span[] = [];

/** Connect to the orchestrator (idempotent). Main brokers a `MessagePort`
 *  pair; `preload.ts` receives the renderer's port over IPC and hands it off
 *  via `window.postMessage` (a bridge function call can't carry a live port —
 *  structured-clone limits on the bridge itself), so this listens on the DOM
 *  `message` event rather than `ipcRenderer` directly. */
export function connect(): Promise<Channel> {
  return (channel ??= new Promise<Channel>((resolve) => {
    function onPort(e: MessageEvent) {
      if (e.data !== "orchestrator:port") return;
      window.removeEventListener("message", onPort);
      const port = e.ports[0];
      port.start();
      const ch = new Channel(domEndpoint(port));
      // Process-wide diagnostics (e.g. a camera-registry sink throw with no
      // single owning session, a recorder finalize truncation, capture-worker
      // death) — surface to the console AND the dismissible error tray so the
      // report doesn't dead-end in a packaged app.
      ch.on(
        topic.error,
        ({ scope, message, level }: { scope: string; message: string; level?: ErrorReport["level"] }) => {
          if (level === "warning") console.warn(`[orchestrator:${scope}]`, message);
          else console.error(`[orchestrator:${scope}]`, message);
          reportToTray(scope, message, level ?? "error");
        },
      );
      ch.on(topic.span, (s: Span) => {
        orchestratorSpans.push(s);
        if (orchestratorSpans.length > SPAN_RING_CAPACITY) orchestratorSpans.shift();
      });
      resolve(ch);
    }
    window.addEventListener("message", onPort);
    window.foveaBridge.connectOrchestrator();
  }));
}

/** Why the orchestrator process went down, delivered on the `orchestrator:down`
 *  push. `clean` = it acked a
 *  graceful quiesce before exit; `killed` = main terminated it (quit / hung-
 *  quiesce timeout) without an ack; `crash` = it died unexpectedly (native
 *  fault, signal, OOM). The clean/crash decision is ACK-based on main's side —
 *  never exit-code guessing. */
export type OrchestratorDownReason = "clean" | "killed" | "crash";
export type OrchestratorDownReport = {
  reason: OrchestratorDownReason;
  /** Process exit code, or null for a signal/unknown death. INFORMATIONAL only
   *  (shown in the crash banner) — never the clean/crash discriminator. */
  code: number | null;
  message?: string;
  // ---- Crash diagnostics. Present only on a NON-clean exit; main flushes
  // the instance's stdout/stderr ring to a file and enriches the report before
  // it reaches the window. All optional — a `clean` report never carries them.
  /** Absolute path to the flushed per-instance stdout/stderr ring buffer
   *  (`<userData>/crash-logs/<instanceId>-<timestamp>.log`). */
  logPath?: string;
  /** Tail (~30 lines) of that ring, inlined so the crash banner needn't read
   *  the file to show recent output. Oldest → newest. */
  lastLines?: string[];
  /** Absolute path to a native minidump captured by Electron's crashReporter
   *  for this instance's process, if one landed after it forked
   *  (`<userData>/crash-dumps/…/*.dmp`). Best-effort — a minidump may not be
   *  flushed by the time the exit is observed. */
  dumpPath?: string;
};

/** Reactive last-seen orchestrator-down report for THIS window, or null while
 *  the orchestrator is up. The crash surface (`CrashReport.vue`) renders off
 *  it. Owner-scoping: set ONLY when this window actually held an
 *  orchestrator channel, so a window never associated with the dead task
 *  ignores the broadcast. A `clean` report is recorded but the surface hides
 *  it (a graceful shutdown is not a user-facing failure). */
export const orchestratorDown = shallowRef<OrchestratorDownReport | null>(null);

// If the orchestrator process dies, every request awaiting a response on the
// current channel would otherwise hang forever (a module `await`ing a command
// inside <suspense> never resolves). `main.ts` owns the child process and
// detects the exit reliably, so it broadcasts here instead of relying on
// MessagePort close semantics across a process crash. Full transparent
// reconnect (respawn + re-subscribe already-mounted sessions) is out of scope.
window.foveaBridge.onOrchestratorDown((report) => {
  // Only surface in windows that actually connected to the orchestrator — a
  // passive/never-connected window is not "associated with the dead task".
  if (channel) orchestratorDown.value = report;
  channel?.then((ch) => ch.close());
});

// Renderer-side event-loop lag probe — started once at module load, module-scope
// singleton so every `StreamView` inspector overlay reads the same numbers
// instead of each starting its own timer. Read directly (not via a Vue ref)
// by `StreamView`'s inspector `computed`, which already re-runs at frame
// rate off `props.payload` — no extra reactivity plumbing needed, and this
// stays out of Vue on principle (`@lib/util/rolling.ts`, not `perf.ts`).
export const rendererLoopLag = startLoopLagProbe();

const rendererFrameTimings = new Map<
  string,
  { ipcLatencyMs: RollingStats; displayDelayMs: RollingStats }
>();

function timing(topic: string) {
  let s = rendererFrameTimings.get(topic);
  if (!s) {
    s = {
      ipcLatencyMs: new RollingStats(0.7, 1, "ms"),
      displayDelayMs: new RollingStats(0.7, 1, "ms"),
    };
    rendererFrameTimings.set(topic, s);
  }
  return s;
}

function timingSnapshot(s: RollingStats | undefined): FrameTimingStats {
  return s ? { count: s.count, mean: s.mean, max: s.max } : { count: 0, mean: 0, max: 0 };
}

export function rendererFrameTimingSnapshot(): Record<
  string,
  { ipcLatencyMs: FrameTimingStats; displayDelayMs: FrameTimingStats }
> {
  return Object.fromEntries(
    [...rendererFrameTimings].map(([topic, s]) => [
      topic,
      {
        ipcLatencyMs: timingSnapshot(s.ipcLatencyMs),
        displayDelayMs: timingSnapshot(s.displayDelayMs),
      },
    ]),
  );
}

function shmReadSummary(stats = shmReadStats()): Record<string, string> {
  return {
    reads: formatCounterRate(stats.rates.reads),
    nulls: formatCounterRate(stats.rates.nulls),
    timeouts: formatCounterRate(stats.rates.timeouts),
    errors: formatCounterRate(stats.rates.errors),
    allocations: formatCounterRate(stats.rates.allocations),
    poolHits: formatCounterRate(stats.rates.poolHits),
    latencyMs: formatSampleStats(stats.latencyMs),
  };
}

// Perf snapshot dump — Ctrl+Shift+S while inspector mode is on (see
// `inspectorMode` in `@lib/util/perf.ts`) fetches `system.perfSnapshot`,
// merges in this renderer's own loop lag, and writes it under the app data
// dir. Gated on inspector mode so it's not a stray global shortcut most of
// the time; pick something else if this collides on your platform.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (!inspectorMode.value) return;
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
      void dumpPerfSnapshot();
    }
  });
}

/** Fetch `system.perfSnapshot`, merge in this window's own render loop lag,
 *  and write it under the app data dir. Exported so the profiler window's
 *  export button can trigger the same dump the keybind does. */
export async function dumpPerfSnapshot(): Promise<string> {
  const ch = await connect();
  const snapshot = await ch.request<Record<string, unknown>>(
    topic.command("system", "perfSnapshot"),
    undefined,
  );
  const shmReads = shmReadStats();
  const merged = {
    ...snapshot,
    renderer: {
      loopLag: { mean: rendererLoopLag.stats.mean, max: rendererLoopLag.stats.max },
      frames: rendererFrameTimingSnapshot(),
      shmReads,
      shmReadSummary: shmReadSummary(shmReads),
    },
  };
  const file = await window.foveaBridge.writePerfSnapshot(JSON.stringify(merged, null, 2));
  console.log(`[perf] snapshot written to ${file}`);
  return file;
}

/** What the renderer DISPLAYS: the wire `FramePayload` plus the stream address,
 *  stamped CLIENT-SIDE at the two ref chokepoints (`useSession().frame()`,
 *  `usePipeFrame()`). The wire types stay transport-only; `source` never
 *  crosses a process boundary. Carrying the address on the displayed payload is what
 *  makes `StreamView`'s projection button implicit — any surface bound to one
 *  of these refs is projectable with zero extra wiring. */
export type StreamPayload = FramePayload & { source?: PaneSource };

/** What `useSession().frame(name)` returns: the reactive `payload` ref (each
 *  displayed payload carries its client-stamped `source` address). */
export type FrameRef = {
  payload: Readonly<Ref<StreamPayload | null>>;
};

export type Session<C extends Contract> = {
  /** Reactive, mutable — read/write as plain properties (`state.foo`). Writing
   *  commands the orchestrator (setState); the value updates optimistically
   *  and reconciles against the server echo. */
  state: StateOf<C>;
  /** Reactive, readonly — read as plain properties (`telemetry.foo`). */
  telemetry: Readonly<TelemetryOf<C>>;
  /** Reactive, readonly — the current session status: `error` (the user-visible
   *  failure, or null) and `progress` (the in-flight activation step list,
   *  or null). Seeded on subscribe and updated live;
   *  additive, so modules opt in to showing it. */
  status: Readonly<SessionStatus>;
  // `string & {}` keeps autocomplete for the contract's static frame names while
  // still allowing dynamic channels (e.g. one per camera serial).
  frame(name: FrameOf<C> | (string & {})): FrameRef;
  call<K extends keyof CommandsOf<C>>(
    name: K,
    arg: CommandsOf<C>[K]["arg"],
  ): Promise<CommandsOf<C>[K]["ret"]>;
};

export function useFrames<C extends Contract, K extends string>(
  session: Session<C>,
  names: readonly K[],
): Record<K, FrameRef> {
  const frames = {} as Record<K, FrameRef>;
  for (const name of names) frames[name] = session.frame(name);
  return frames;
}

export function useDynamicFrame<C extends Contract>(
  session: Session<C>,
  name: Ref<string | null | undefined> | (() => string | null | undefined),
): Readonly<Ref<StreamPayload | null>> {
  const read = typeof name === "function" ? name : () => name.value;
  return computed(() => {
    const key = read();
    return key ? session.frame(key).payload.value : null;
  });
}

// The renderer's pipe reader IO, backed by the shared shm client's pool
// (`readPipe`/`releaseBuffer`) — the transport `createPipeConsumer` polls.
const pipeReaderIO: PipeReaderIO = {
  readPipe: (shmName, lastSeq, bytes) => shm.readPipe(shmName, lastSeq, bytes),
  releaseBuffer: (buffer) => shm.releaseBuffer(buffer),
};

/**
 * Bind a reactive `FramePayload` ref to an advertised SHM pipe — the renderer's
 * replacement for `session.frame()` on the raw-camera preview surfaces.
 * Discovers the pipe from the `pipes` session's reactive `state.pipes`,
 * `connectPipe`s once for a `PipeHandle`, streams frames via
 * `createPipeConsumer` (pixels ride the shared segment, never the Channel),
 * RECONNECTS on an epoch bump (reuse-safe id), and CLEARS on
 * un-advertise / CLOSED. `pipeId` may be static or a ref/getter (e.g. the
 * currently-selected `camera:<serial>`); pass null to bind nothing. Returns a
 * readonly ref for `StreamView :payload`; each displayed payload carries its
 * client-stamped `{kind:"pipe"}` address, so the bound view is projectable
 * implicitly.
 */
export function usePipeFrame(
  pipeId: MaybeRefOrGetter<string | null | undefined>,
): Readonly<Ref<StreamPayload | null>> {
  const session = useSession(pipes, "pipes");
  const frame = shallowRef<StreamPayload | null>(null);
  let consumer: PipeConsumer | null = null;
  let boundId: string | null = null;
  let boundEpoch: number | null = null;

  function teardown(): void {
    consumer?.stop();
    consumer = null;
    // The balancing disconnect surfaces its rejection instead of hiding it:
    // `session.call` routes a failed disconnect (a dead channel) to the error
    // tray, and its detached default handler keeps a dead-channel reject from
    // becoming an unhandled rejection.
    if (boundId) void session.call("disconnectPipe", { pipeId: boundId });
    boundId = null;
    boundEpoch = null;
    frame.value = null;
  }

  async function bind(id: string, epoch: number): Promise<void> {
    boundId = id;
    boundEpoch = epoch;
    let handle: PipeHandle;
    try {
      handle = await session.call("connectPipe", { pipeId: id });
    } catch {
      return; // pipe vanished between discovery and connect — the watch retries
    }
    // A newer bind replaced us while connecting — abort this one.
    if (boundId !== id || boundEpoch !== epoch) return;
    // Client-side stamp: one address object per bind, applied to every
    // displayed payload so `StreamView` derives projectability implicitly.
    const address: PaneSource = { kind: "pipe", id };
    consumer = createPipeConsumer(
      handle,
      pipeReaderIO,
      (p) => {
        const stamped: StreamPayload | null = p;
        if (stamped) stamped.source = address;
        frame.value = stamped; // p === null on CLOSED → clears the display
      },
      // After a streak of failed reads (a dead/stalled pipe), surface once to
      // the tray.
      ({ consecutive, error }) =>
        reportToTray(
          "pipe",
          `${id}: ${consecutive} consecutive read failures — ${errMessage(error)}`,
        ),
    );
    consumer.start();
  }

  // Watch a primitive `id#epoch` key so the effect fires only on a real change
  // (a new pipe, a switched selection, or an epoch bump), not every state push.
  watch(
    () => {
      const id = toValue(pipeId);
      const advert = id ? session.state.pipes[id] : undefined;
      return id && advert ? `${id}#${advert.epoch}` : null;
    },
    (key) => {
      if (!key) {
        if (boundId) teardown();
        return;
      }
      const hash = key.lastIndexOf("#");
      const id = key.slice(0, hash);
      const epoch = Number(key.slice(hash + 1));
      if (boundId === id && boundEpoch === epoch) return; // already bound
      if (boundId) teardown();
      void bind(id, epoch);
    },
    { immediate: true },
  );

  onScopeDispose(teardown);
  return readonly(frame) as Readonly<Ref<StreamPayload | null>>;
}

function readSource<T>(source: Ref<T> | (() => T)): T {
  return typeof source === "function" ? source() : source.value;
}

export function bindField<
  C extends Contract,
  T extends Record<string, any>,
  K extends keyof T,
  Cmd extends keyof CommandsOf<C>,
>(
  session: Session<C>,
  source: Ref<T | undefined> | (() => T | undefined),
  key: K,
  cmd: Cmd,
  arg: (key: K, value: T[K]) => CommandsOf<C>[Cmd]["arg"],
  fallback: T[K],
): WritableComputedRef<T[K]>;
export function bindField<
  C extends Contract,
  T extends Record<string, any>,
  K extends keyof T,
  Cmd extends keyof CommandsOf<C>,
>(
  session: Session<C>,
  source: Ref<T | undefined> | (() => T | undefined),
  key: K,
  cmd: Cmd,
  arg: (key: K, value: T[K]) => CommandsOf<C>[Cmd]["arg"],
): WritableComputedRef<T[K] | undefined>;
export function bindField<
  C extends Contract,
  T extends Record<string, any>,
  K extends keyof T,
  Cmd extends keyof CommandsOf<C>,
>(
  session: Session<C>,
  source: Ref<T | undefined> | (() => T | undefined),
  key: K,
  cmd: Cmd,
  arg: (key: K, value: T[K]) => CommandsOf<C>[Cmd]["arg"],
  fallback?: T[K],
): WritableComputedRef<T[K] | undefined> {
  return computed<T[K] | undefined>({
    get: () => readSource(source)?.[key] ?? fallback,
    set: (value) => {
      void session.call(cmd, arg(key, value as T[K]));
    },
  });
}

export type UseSessionOptions = {
  passive?: boolean;
};

/**
 * Bind a typed session — `state`/`telemetry` mirror the same shape the server
 * `ServerSession` exposes, so a module reads `session.state.verge`
 * directly instead of `session.state("verge").value`. Active subscriptions are
 * torn down with the current effect scope, decrementing the orchestrator's
 * activation interest; passive subscriptions observe state/telemetry without
 * starting session-owned resources.
 */
export function useSession<C extends Contract>(
  contract: C,
  name: string,
  options: UseSessionOptions = {},
): Session<C> {
  const frameRefs = new Map<string, FrameRef>();
  const ready = connect();
  const disposers: Array<() => void> = [];
  const subscription = {
    name,
    passive: options.passive || undefined,
  };
  // Tell the orchestrator we're observing this session. Passive observers get
  // state/telemetry but don't start session resources.
  ready.then((ch) => ch.emit(topic.subscribe, subscription));
  onScopeDispose(() => {
    disposers.forEach((d) => d());
    ready.then((ch) => ch.emit(topic.unsubscribe, subscription));
  });
  const track = (unsub: Promise<() => void>) =>
    unsub.then((d) => disposers.push(d));

  // State: one customRef per contract key, merged into a single reactive
  // object via Vue's ref-unwrapping-in-reactive-objects behavior (a ref held
  // as a property of a `reactive()` object reads/writes transparently, no
  // `.value` needed). Contract state is a small, fixed POJO, so every key is
  // wired eagerly here rather than lazily per-access.
  const stateRefs: Record<string, Ref<any>> = {};
  for (const k of Object.keys(contract.state)) {
    let value = (contract.state as any)[k];
    let trigger = () => {};
    const r = customRef((tr, tg) => {
      trigger = tg;
      return {
        get: () => (tr(), value),
        set: (v) => {
          value = v;
          tg();
          ready.then((ch) => ch.emit(topic.setState(name), { key: k, value: v }));
        },
      };
    });
    stateRefs[k] = r;
    track(
      ready.then((ch) =>
        ch.on(topic.state(name), (patch: { key: string; value: any }) => {
          if (patch.key === k && patch.value !== value) {
            value = patch.value;
            trigger();
          }
        }),
      ),
    );
  }
  const state = reactive(stateRefs) as unknown as StateOf<C>;

  // Telemetry: same merge, readonly.
  const telemetryRefs: Record<string, Ref<any>> = {};
  for (const k of Object.keys(contract.telemetry)) {
    const r = shallowRef((contract.telemetry as any)[k]);
    telemetryRefs[k] = r;
    track(
      ready.then((ch) =>
        ch.on(topic.telemetry(name), (patch: Record<string, any>) => {
          if (k in patch) r.value = patch[k];
        }),
      ),
    );
  }
  const telemetry = readonly(reactive(telemetryRefs)) as Readonly<TelemetryOf<C>>;

  // Status: one reactive object carrying the current failure AND the in-flight
  // activation progress list, seeded on subscribe and updated live via the
  // status topic.
  const statusState = reactive<SessionStatus>({ error: null, progress: null });
  track(
    ready.then((ch) =>
      ch.on(topic.status(name), (s: SessionStatus) => {
        statusState.error = s.error;
        statusState.progress = s.progress;
      }),
    ),
  );
  const status = readonly(statusState) as Readonly<SessionStatus>;

  function frame(fname: string): FrameRef {
    const k = String(fname);
    const cached = frameRefs.get(k);
    if (cached) return cached;
    {
      const r = shallowRef<StreamPayload | null>(null);
      // The stream address is client-only — stamped onto each DISPLAYED
      // payload below (after the shm materialize), never onto the wire types.
      const address: PaneSource = { kind: "frame", session: name, frame: k };
      const fref: FrameRef = {
        payload: readonly(r) as Readonly<Ref<StreamPayload | null>>,
      };
      frameRefs.set(k, fref);
      // Coalesce bursts to one paint: keep only the latest until the next rAF.
      let latest: FramePayload | null = null;
      let scheduled = false;
      let token = 0;
      let rafId = 0; // pending flush handle — cancelled on scope dispose
      const frameTopic = topic.frame(name, k);
      const flush = () => {
        scheduled = false;
        rafId = 0;
        const pending = latest;
        latest = null;
        const myToken = ++token;
        if (!pending) {
          r.value = null;
          return;
        }
        void shm.read(pending).then((payload) => {
          if (myToken !== token) {
            shm.release(payload);
            return;
          }
          if (payload?.meta) {
            payload.meta.tDisplay = Date.now();
            if (payload.meta.tReceive !== undefined)
              timing(frameTopic).displayDelayMs.push(
                payload.meta.tDisplay - payload.meta.tReceive,
              );
          }
          const stamped: StreamPayload | null = payload;
          if (stamped) stamped.source = address;
          shm.release(r.value);
          r.value = stamped;
          if (latest && !scheduled) {
            scheduled = true;
            rafId = requestAnimationFrame(flush);
          }
        });
      };
      track(
        ready.then((ch) => {
          // Tell the orchestrator this topic is actually read, once, the
          // first time this ref is created — see `ServerSession.frame()`.
          ch.declareFrameInterest(frameTopic);
          return ch.onFrame(frameTopic, (payload) => {
            if (payload.meta) {
              payload.meta.tReceive = Date.now();
              if (payload.meta.tPublish !== undefined)
                timing(frameTopic).ipcLatencyMs.push(
                  payload.meta.tReceive - payload.meta.tPublish,
                );
            }
            // The stream address is stamped client-side in `flush` (on the
            // DISPLAYED payload), not carried on the wire `meta`.
            latest = payload;
            if (!scheduled) {
              scheduled = true;
              rafId = requestAnimationFrame(flush);
            }
          });
        }),
      );
      // On scope dispose, RELEASE the last displayed shm buffer back to the
      // pool and CANCEL any pending flush — otherwise the final materialized
      // payload is stranded (pool `outstanding` ratchets, buckets become
      // unevictable, the hwm never decays) and an in-flight rAF could paint
      // after teardown. Bumping `token` also makes any in-flight `shm.read`
      // resolve into the release-and-drop branch instead of assigning.
      disposers.push(() => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        scheduled = false;
        token++;
        latest = null;
        shm.release(r.value);
        r.value = null;
      });
      return fref;
    }
  }

  return {
    state,
    telemetry,
    status,
    frame,
    call(cname, arg) {
      const p = ready.then((ch) =>
        ch.request(topic.command(name, String(cname)), arg),
      );
      // Default rejection surface: bare `session.call()` sites would otherwise
      // drop command rejections — the "clicked and nothing happened" class.
      // Route EVERY rejection to the error tray at this ONE chokepoint.
      // DOUBLE-SURFACE semantics: the tray entry ALWAYS lands, on a DETACHED
      // `.catch` branch, so `p` itself still rejects — a caller that adds its
      // own `.catch(...)` runs additionally (for local UI / control flow) and
      // does NOT suppress the tray. The detached branch also means
      // `void session.call(...)` never becomes an unhandled rejection.
      // `bindField`/`usePidOverride` (`void session.call`) inherit this for free.
      p.catch((err) => reportToTray(name, `${String(cname)}: ${errMessage(err)}`));
      return p;
    },
  };
}

export function useController(options: UseSessionOptions = {}): Session<typeof controller> {
  return useSession(controller, "controller", options);
}

/**
 * Observe a session's STATUS (`error` + spin-up `progress`) generically — no
 * typed contract, no state/telemetry plumbing. A PASSIVE subscriber (never
 * counts toward activation), so a host shell (e.g. `AppWindow`) can render the
 * progress overlay for WHATEVER app it hosts while the app's own `useSession`
 * drives the active subscription that triggers activation. Subscription is torn
 * down with the current effect scope. Reactive + readonly, same shape as
 * `useSession(...).status`.
 */
export function useSessionStatus(name: string): Readonly<SessionStatus> {
  const statusState = reactive<SessionStatus>({ error: null, progress: null });
  const ready = connect();
  const subscription = { name, passive: true };
  ready.then((ch) => ch.emit(topic.subscribe, subscription));
  const disposers: Array<() => void> = [];
  ready.then((ch) =>
    disposers.push(
      ch.on(topic.status(name), (s: SessionStatus) => {
        statusState.error = s.error;
        statusState.progress = s.progress;
      }),
    ),
  );
  onScopeDispose(() => {
    disposers.forEach((d) => d());
    ready.then((ch) => ch.emit(topic.unsubscribe, subscription));
  });
  return readonly(statusState) as Readonly<SessionStatus>;
}

/** The reactive PID-override proxy `usePidOverride` returns:
 *  property access, not `.value.value`. Assigning `.value` engages/updates the
 *  server slot; `.release()` (or `.value = null`) releases; `.engaged`/reading
 *  `.value` mirror the server-authoritative state. */
export type PidOverrideProxy<V> = {
  /** Get: the current server override value (null while released). Set: engage
   *  (or update) the override at `v`; setting `null` releases. */
  value: V | null;
  /** Server-authoritative: is the override currently engaged? */
  readonly engaged: boolean;
  /** Release the override (control resumes; the node's `seed` keeps it
   *  continuous). */
  release(): void;
};

/**
 * Bind a REACTIVE override proxy over a module's PID-override contract fragment
 * (`@lib/orchestrator/pid-override-contract`). The renderer drag code writes
 * `proxy.value = v` (or `proxy.release()`) and reads `proxy.engaged`; nothing
 * else touches the slot. Reactive because every accessor reads the reactive
 * `session.state`, so templates/`watch` track it for free — the same principle
 * as the rest of this client (all authoritative state lives server-side, the
 * renderer holds echoes).
 *
 * Reusable by ANY module (not disparity-specific): a module with one PID node
 * uses the default `pidOverride` state key + command; a multi-node module
 * passes distinct `stateKey`/`command` names matching its contract.
 *
 * `V` is the module's node value type (e.g. `{ l, r }` volts) — supply it
 * explicitly, it can't be inferred from the untyped state key.
 */
export function usePidOverride<C extends Contract, V>(
  session: Session<C>,
  options: { stateKey?: string; command?: string } = {},
): PidOverrideProxy<V> {
  const stateKey = options.stateKey ?? PID_OVERRIDE_KEYS.state;
  const command = options.command ?? PID_OVERRIDE_KEYS.command;
  const read = (): PidOverrideState<V> =>
    ((session.state as Record<string, unknown>)[stateKey] as
      | PidOverrideState<V>
      | undefined) ?? { engaged: false, value: null };
  const send = (payload: PidOverrideCommand<V>): void => {
    // The command is contract-declared on the module, not statically known
    // here (this helper is module-generic) — dispatch by name.
    void session.call(command as keyof CommandsOf<C>, payload as never);
  };
  return reactive({
    get value(): V | null {
      return read().value;
    },
    set value(v: V | null) {
      if (v === null) send({ release: true });
      else send({ value: v });
    },
    get engaged(): boolean {
      return read().engaged;
    },
    release(): void {
      send({ release: true });
    },
  }) as PidOverrideProxy<V>;
}
