// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer-side orchestrator client. Wraps the RPC `Channel` in Vue's reactive
// shape so modules read/write authoritative orchestrator state as if it were
// local — the same shape the server session sees (§12.3 R3):
//   - state      → reactive, mutable object (property set = command; value
//                  tracks the server echo)
//   - telemetry  → reactive, readonly object (driven by subscription)
//   - frame(name)→ readonly Ref (dynamic keys, e.g. one per camera serial,
//                  don't fit a fixed reactive object — stays a lazy accessor,
//                  latest-wins, coalesced to one rAF)
//   - call(name, arg) → Promise of the command result
//
// All authoritative state lives in the orchestrator; the renderer holds only
// echoes, so multiple windows stay consistent for free. `state`/`telemetry`
// keys are enumerated once from the contract's default POJOs at `useSession()`
// time (both are small, fixed shapes), so every key is live immediately —
// no per-key lazy registration to forget.

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

/** Rebuild the Mat shape (`FrameView`/vision ops expect) from a frame payload. */
export function payloadToMat(p: FramePayload | null): Mat<Uint8Array> | null {
  if (!p?.data) return null;
  return Object.assign(new Uint8Array(p.data), {
    shape: p.shape,
    channels: p.channels,
  }) as unknown as Mat<Uint8Array>;
}

// Renderer SHM transfer pool (C-P2) — the ping-pong buffer pool, port
// handshake, timeout, and message protocol with the preload live in their own
// module now. Module-scope singleton, matching the previous inline state: one
// pool per renderer window (the display path calls `shm.read()` in the frame
// flush and `shm.release()` when a materialized frame is displaced).
const shm = createShmClient();

/** Observe-only snapshot of the renderer SHM transfer pool (C-P9): read
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

let channel: Promise<Channel> | null = null;

// Live boot/activation/connect timing feed (§7.1 S5) — bounded ring, module-
// scope singleton like `rendererLoopLag` below, so a future profiler window
// (§7.1 S4) can render a timeline without polling `perfSnapshot`.
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
      // single owning session) — always surface to the renderer console.
      ch.on(topic.error, ({ scope, message }: { scope: string; message: string }) =>
        console.error(`[orchestrator:${scope}]`, message),
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

// If the orchestrator process dies, every request awaiting a response on the
// current channel would otherwise hang forever (a module `await`ing a command
// inside <suspense> never resolves). `main.ts` owns the child process and
// detects the exit reliably, so it broadcasts here instead of relying on
// MessagePort close semantics across a process crash. Full transparent
// reconnect (respawn + re-subscribe already-mounted sessions) is out of scope
// for this fix — see docs/history/refactor/orchestrator.md §12.1 C5 / §12.3 R3.
window.foveaBridge.onOrchestratorDown(() => {
  channel?.then((ch) => ch.close());
});

// Renderer-side event-loop lag probe (perf substrate, docs/history/refactor/
// orchestrator.md §7.3 item 1) — started once at module load, module-scope
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

// Perf snapshot dump (§7.3 item 4) — Ctrl+Shift+S while inspector mode is on
// (see `inspectorMode` in `@lib/util/perf.ts`) fetches `system.perfSnapshot`,
// merges in this renderer's own loop lag, and writes it under the app data
// dir. Gated on inspector mode so it's not a stray global shortcut most of
// the time (same reasoning as the Ctrl+Shift+I collision note, §6 V2 — pick
// something else if this collides on your platform).
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
 *  export button (§7.1 S4) can trigger the same dump the keybind does. */
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

/** A frame channel's stream address (session + frame-channel name). Static per
 *  `frame(name)` — the client half of what A-P12 lifted out of wire `FrameMeta`. */
export type FrameSource = { session: string; frame: string };

/** What `useSession().frame(name)` returns (A-P12): the reactive `payload` ref
 *  plus the stream `source`, carried out-of-band instead of folded into the
 *  wire payload's `meta`. `source` is constant for the channel. */
export type FrameRef = {
  payload: Readonly<Ref<FramePayload | null>>;
  source: FrameSource;
};

export type Session<C extends Contract> = {
  /** Reactive, mutable — read/write as plain properties (`state.foo`). Writing
   *  commands the orchestrator (setState); the value updates optimistically
   *  and reconciles against the server echo. */
  state: StateOf<C>;
  /** Reactive, readonly — read as plain properties (`telemetry.foo`). */
  telemetry: Readonly<TelemetryOf<C>>;
  /** Reactive, readonly — the current user-visible session failure
   *  (`status.error`), or null. Seeded on subscribe and updated live (A-P13);
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
): Readonly<Ref<FramePayload | null>> {
  const read = typeof name === "function" ? name : () => name.value;
  return computed(() => {
    const key = read();
    return key ? session.frame(key).payload.value : null;
  });
}

// The renderer's pipe reader IO, backed by the shared shm client's C-15 pool
// (`readPipe`/`releaseBuffer`) — the transport `createPipeConsumer` polls.
const pipeReaderIO: PipeReaderIO = {
  readPipe: (shmName, lastSeq, bytes) => shm.readPipe(shmName, lastSeq, bytes),
  releaseBuffer: (buffer) => shm.releaseBuffer(buffer),
};

/**
 * Bind a reactive `FramePayload` ref to an advertised SHM pipe (WS1 real-1c) —
 * the renderer's replacement for `session.frame()` on the raw-camera preview
 * surfaces. Discovers the pipe from the `pipes` session's reactive `state.pipes`,
 * `connectPipe`s once for a `PipeHandle`, streams frames via C's
 * `createPipeConsumer` (pixels ride the shared segment, never the Channel),
 * RECONNECTS on an epoch bump (C-20 reuse-safe id), and CLEARS on
 * un-advertise / CLOSED. `pipeId` may be static or a ref/getter (e.g. the
 * currently-selected `camera:<serial>`); pass null to bind nothing. Returns a
 * readonly ref for `StreamView :payload`.
 */
export function usePipeFrame(
  pipeId: MaybeRefOrGetter<string | null | undefined>,
): Readonly<Ref<FramePayload | null>> {
  const session = useSession(pipes, "pipes");
  const frame = shallowRef<FramePayload | null>(null);
  let consumer: PipeConsumer | null = null;
  let boundId: string | null = null;
  let boundEpoch: number | null = null;

  function teardown(): void {
    consumer?.stop();
    consumer = null;
    if (boundId) void session.call("disconnectPipe", { pipeId: boundId }).catch(() => {});
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
    // A newer bind superseded us while connecting — abort this one.
    if (boundId !== id || boundEpoch !== epoch) return;
    consumer = createPipeConsumer(handle, pipeReaderIO, (p) => {
      frame.value = p; // p === null on CLOSED → clears the display
    });
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
  return readonly(frame) as Readonly<Ref<FramePayload | null>>;
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
 * `ServerSession` exposes (§12.3 R3), so a module reads `session.state.verge`
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

  // Status (A-P13): one reactive object carrying the current failure, seeded on
  // subscribe and updated live via the status topic.
  const statusState = reactive<SessionStatus>({ error: null });
  track(
    ready.then((ch) =>
      ch.on(topic.status(name), (s: SessionStatus) => {
        statusState.error = s.error;
      }),
    ),
  );
  const status = readonly(statusState) as Readonly<SessionStatus>;

  function frame(fname: string): FrameRef {
    const k = String(fname);
    const cached = frameRefs.get(k);
    if (cached) return cached;
    {
      const r = shallowRef<FramePayload | null>(null);
      const fref: FrameRef = {
        payload: readonly(r) as Readonly<Ref<FramePayload | null>>,
        source: { session: name, frame: k },
      };
      frameRefs.set(k, fref);
      // Coalesce bursts to one paint: keep only the latest until the next rAF.
      let latest: FramePayload | null = null;
      let scheduled = false;
      let token = 0;
      const frameTopic = topic.frame(name, k);
      const flush = () => {
        scheduled = false;
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
          shm.release(r.value);
          r.value = payload;
          if (latest && !scheduled) {
            scheduled = true;
            requestAnimationFrame(flush);
          }
        });
      };
      track(
        ready.then((ch) => {
          // C10: tell the orchestrator this topic is actually read, once, the
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
            // A-P12: the stream address is carried by the returned `FrameRef`
            // (static `source`), not stamped onto each payload's meta anymore.
            latest = payload;
            if (!scheduled) {
              scheduled = true;
              requestAnimationFrame(flush);
            }
          });
        }),
      );
      return fref;
    }
  }

  return {
    state,
    telemetry,
    status,
    frame,
    call(cname, arg) {
      return ready.then((ch) =>
        ch.request(topic.command(name, String(cname)), arg),
      );
    },
  };
}

export function useController(options: UseSessionOptions = {}): Session<typeof controller> {
  return useSession(controller, "controller", options);
}
