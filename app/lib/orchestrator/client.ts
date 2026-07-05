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
import { ipcRenderer } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Mat } from "core/Vision";
import { startLoopLagProbe } from "@lib/util/rolling";
import { inspectorMode } from "@lib/util/perf";
import {
  Channel,
  topic,
  type CommandsOf,
  type Contract,
  type Endpoint,
  type FramePayload,
  type FrameOf,
  type StateOf,
  type TelemetryOf,
} from "./protocol.js";
import type { Span } from "./contracts.js";

/** Rebuild the Mat shape (`FrameView`/vision ops expect) from a frame payload. */
export function payloadToMat(p: FramePayload | null): Mat<Uint8Array> | null {
  if (!p) return null;
  return Object.assign(new Uint8Array(p.data), {
    shape: p.shape,
    channels: p.channels,
  }) as unknown as Mat<Uint8Array>;
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
 *  pair; the renderer receives its port over a one-shot IPC message. */
export function connect(): Promise<Channel> {
  return (channel ??= new Promise<Channel>((resolve) => {
    ipcRenderer.once("orchestrator:port", (e) => {
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
    });
    ipcRenderer.send("orchestrator:connect");
  }));
}

// If the orchestrator process dies, every request awaiting a response on the
// current channel would otherwise hang forever (a module `await`ing a command
// inside <suspense> never resolves). `main.ts` owns the child process and
// detects the exit reliably, so it broadcasts here instead of relying on
// MessagePort close semantics across a process crash. Full transparent
// reconnect (respawn + re-subscribe already-mounted sessions) is out of scope
// for this fix — see docs/refactor/orchestrator.md §12.1 C5 / §12.3 R3.
ipcRenderer.on("orchestrator:down", () => {
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
    },
  };
  const dataPath: string = await ipcRenderer.invoke("get-data-path");
  const dir = resolve(dataPath, "perf-snapshots");
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(merged, null, 2));
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

/**
 * Bind a typed session — `state`/`telemetry` mirror the same shape the server
 * `ServerSession` exposes (§12.3 R3), so a module reads `session.state.verge`
 * directly instead of `session.state("verge").value`. Every subscription is
 * torn down with the current effect scope, decrementing the orchestrator's
 * interest in that stream.
 */
export function useSession<C extends Contract>(
  contract: C,
  name: string,
): Session<C> {
  const frameRefs = new Map<string, Ref<FramePayload | null>>();
  const ready = connect();
  const disposers: Array<() => void> = [];
  // Tell the orchestrator we're interested so it (re)starts session resources;
  // unsubscribe on teardown so it can release them when no window is viewing.
  ready.then((ch) => ch.emit(topic.subscribe, name));
  onScopeDispose(() => {
    disposers.forEach((d) => d());
    ready.then((ch) => ch.emit(topic.unsubscribe, name));
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
      const flush = () => {
        scheduled = false;
        if (latest?.meta) latest.meta.tDisplay = Date.now();
        r!.value = latest;
      };
      track(
        ready.then((ch) => {
          // C10: tell the orchestrator this topic is actually read, once, the
          // first time this ref is created — see `ServerSession.frame()`.
          ch.declareFrameInterest(topic.frame(name, k));
          return ch.onFrame(topic.frame(name, k), (payload) => {
            if (payload.meta) payload.meta.tReceive = Date.now();
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
