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
  customRef,
  onScopeDispose,
  reactive,
  readonly,
  shallowRef,
  type Ref,
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
  type StateOf,
  type TelemetryOf,
} from "./protocol.js";
import type { Span } from "./contracts.js";

/** Rebuild the Mat shape (`FrameView`/vision ops expect) from a frame payload. */
export function payloadToMat(p: FramePayload | null): Mat<Uint8Array> | null {
  if (!p?.data) return null;
  return Object.assign(new Uint8Array(p.data), {
    shape: p.shape,
    channels: p.channels,
  }) as unknown as Mat<Uint8Array>;
}

const shmPools = new Map<number, ArrayBuffer[]>();
const pendingShmReads = new Map<
  number,
  {
    resolve(payload: FramePayload | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let shmReadSeq = 0;
let shmPort: MessagePort | null = null;

function frameByteLength(payload: FramePayload): number {
  return payload.shape.reduce((p, n) => p * n, payload.channels);
}

function releaseShmBuffer(buffer: ArrayBuffer): void {
  const pool = shmPools.get(buffer.byteLength) ?? [];
  if (pool.length < 3) pool.push(buffer);
  shmPools.set(buffer.byteLength, pool);
}

function releaseShmPayload(payload: FramePayload | null): void {
  if (payload?.shm && payload.data) releaseShmBuffer(payload.data);
}

function checkoutShmBuffer(payload: FramePayload): ArrayBuffer {
  return (
    shmPools.get(frameByteLength(payload))?.pop() ??
    new ArrayBuffer(frameByteLength(payload))
  );
}

function handleShmReadDone(data: unknown): void {
  const msg = data as
    | {
        kind: "fovea:shm:read-done";
        id: number;
        payload: FramePayload | null;
        buffer?: ArrayBuffer;
        error?: string;
      }
    | undefined;
  if (msg?.kind !== "fovea:shm:read-done") return;
  const pending = pendingShmReads.get(msg.id);
  if (!pending) {
    if (msg.buffer) releaseShmBuffer(msg.buffer);
    return;
  }
  clearTimeout(pending.timer);
  pendingShmReads.delete(msg.id);
  if (msg.error) {
    if (msg.buffer) releaseShmBuffer(msg.buffer);
    pending.reject(new Error(msg.error));
  } else {
    if (!msg.payload && msg.buffer) releaseShmBuffer(msg.buffer);
    pending.resolve(msg.payload);
  }
}

function ensureShmPort(): MessagePort | null {
  if (shmPort) return shmPort;
  if (typeof window === "undefined" || typeof MessageChannel === "undefined")
    return null;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => handleShmReadDone(event.data);
  channel.port1.start();
  window.postMessage({ kind: "fovea:shm:init" }, "*", [channel.port2]);
  shmPort = channel.port1;
  return shmPort;
}

function readShmFrameViaTransfer(payload: FramePayload): Promise<FramePayload | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const port = ensureShmPort();
  if (!port) {
    return Promise.reject(new Error("SHM MessagePort transfer pool unavailable"));
  }
  const id = ++shmReadSeq;
  const buffer = checkoutShmBuffer(payload);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingShmReads.delete(id);
      reject(new Error("SHM transfer read timed out"));
    }, 250);
    pendingShmReads.set(id, { resolve, reject, timer });
    port.postMessage({ kind: "fovea:shm:read", id, payload, buffer }, [buffer]);
  });
}

async function materializeFramePayload(
  p: FramePayload,
): Promise<FramePayload | null> {
  if (p.data || !p.shm) return p;
  try {
    return await readShmFrameViaTransfer(p);
  } catch (error) {
    console.error("[shm] transfer-pool read failed", error);
    return null;
  }
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
// for this fix — see docs/refactor/orchestrator.md §12.1 C5 / §12.3 R3.
window.foveaBridge.onOrchestratorDown(() => {
  channel?.then((ch) => ch.close());
});

// Renderer-side event-loop lag probe (perf substrate, docs/refactor/
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
export async function dumpPerfSnapshot(): Promise<void> {
  const ch = await connect();
  const snapshot = await ch.request<Record<string, unknown>>(
    topic.command("system", "perfSnapshot"),
    undefined,
  );
  const merged = {
    ...snapshot,
    renderer: {
      loopLag: { mean: rendererLoopLag.stats.mean, max: rendererLoopLag.stats.max },
      frames: rendererFrameTimingSnapshot(),
    },
  };
  const file = await window.foveaBridge.writePerfSnapshot(JSON.stringify(merged, null, 2));
  console.log(`[perf] snapshot written to ${file}`);
}

export type Session<C extends Contract> = {
  /** Reactive, mutable — read/write as plain properties (`state.foo`). Writing
   *  commands the orchestrator (setState); the value updates optimistically
   *  and reconciles against the server echo. */
  state: StateOf<C>;
  /** Reactive, readonly — read as plain properties (`telemetry.foo`). */
  telemetry: Readonly<TelemetryOf<C>>;
  // `string & {}` keeps autocomplete for the contract's static frame names while
  // still allowing dynamic channels (e.g. one per camera serial).
  frame(name: FrameOf<C> | (string & {})): Readonly<Ref<FramePayload | null>>;
  call<K extends keyof CommandsOf<C>>(
    name: K,
    arg: CommandsOf<C>[K]["arg"],
  ): Promise<CommandsOf<C>[K]["ret"]>;
};

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
  const frameRefs = new Map<string, Ref<FramePayload | null>>();
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

  function frame(fname: string): Readonly<Ref<FramePayload | null>> {
    const k = String(fname);
    let r = frameRefs.get(k);
    if (!r) {
      r = shallowRef<FramePayload | null>(null);
      frameRefs.set(k, r);
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
          r!.value = null;
          return;
        }
        void materializeFramePayload(pending).then((payload) => {
          if (myToken !== token) {
            releaseShmPayload(payload);
            return;
          }
          if (payload?.meta) {
            payload.meta.tDisplay = Date.now();
            if (payload.meta.tReceive !== undefined)
              timing(frameTopic).displayDelayMs.push(
                payload.meta.tDisplay - payload.meta.tReceive,
              );
          }
          releaseShmPayload(r!.value);
          r!.value = payload;
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
            // Stamp the stream's address (session + frame channel) so display
            // components can act on "this stream" (projection windows,
            // multi-window.md req. 4) without prop-threading the names.
            (payload.meta ??= {}).source = { session: name, frame: k };
            latest = payload;
            if (!scheduled) {
              scheduled = true;
              requestAnimationFrame(flush);
            }
          });
        }),
      );
    }
    return readonly(r) as any;
  }

  return {
    state,
    telemetry,
    frame,
    call(cname, arg) {
      return ready.then((ch) =>
        ch.request(topic.command(name, String(cname)), arg),
      );
    },
  };
}
