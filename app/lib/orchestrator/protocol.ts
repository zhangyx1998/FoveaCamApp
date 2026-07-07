// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Transport-agnostic RPC duplex shared by the orchestrator process and the
// renderer client. It knows nothing about Electron or Vue — it speaks over an
// `Endpoint` (a minimal postMessage/onmessage pair), so the same `Channel`
// runs on a DOM `MessagePort` (renderer) and an Electron `MessagePortMain`
// (orchestrator).
//
// Three message shapes ride one channel:
//   - request / response  (commands, queries)   — correlated by id
//   - event               (state + telemetry)   — fire-and-forget, by topic
//   - frame               (display payloads)     — by topic, carries a buffer

import { RollingStats } from "../util/rolling.js";
import { ratePerSec, snapshotWindow, type SampleStats } from "./stats.js";
import { withFrameMeta } from "./frame-payload.js";

export type Serializable =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | Serializable[]
  | { [key: string]: Serializable }
  | ArrayBuffer
  | ArrayBufferView;

/**
 * Per-frame profiling metadata (transport-observability goal, docs/refactor/
 * orchestrator.md roadmap item 3). Producer-set fields (`tCapture`,
 * `convertMs`) are optional — filled in by whichever session measured them
 * (currently the registry's shared preview loop only); `seq`/`tPublish` are
 * always stamped by `Channel.sendFrame` itself, since only the transport sees
 * actual send order and wire time. `tReceive`/`tDisplay` are stamped
 * renderer-side by `client.ts`. All timestamps share the host `Date.now()`
 * clock — same-machine processes, no cross-clock correlation needed (unlike
 * the native Aravis buffer timestamp, which is a separate device clock
 * domain — see the synced-capture plan for that). `deviceTimestamp` and
 * `systemTimestamp` are copied from native `Frame` objects before release
 * when the producer has them.
 */
export type FrameMeta = {
  /** Per-topic send counter, assigned per `sendFrame` call (including calls
   *  that get coalesced away by the backpressure gate). A gap between two
   *  *received* `seq` values is exactly the number of frames the backpressure
   *  gate dropped in between. */
  seq?: number;
  /** ms when this frame's pixel data became available, where measured;
   *  for frames the producer didn't stamp, `Channel.sendFrame` defaults it
   *  to its own call time — which is *before* `tPublish` if the frame sits
   *  gated behind an in-flight one, not equal to it. */
  tCapture?: number;
  /** ms spent converting the raw sensor frame to the display format, where
   *  measured. */
  convertMs?: number;
  /** Camera/device-clock timestamp from Aravis, when available. */
  deviceTimestamp?: bigint;
  /** Host system timestamp from Aravis, when available. */
  systemTimestamp?: bigint;
  /** ms when `Channel` actually posted this frame on the wire — not when
   *  `sendFrame` was called, since a frame can sit gated behind an in-flight
   *  one first. */
  tPublish?: number;
  /** ms when the renderer's `Channel` received this frame. */
  tReceive?: number;
  /** ms when the rAF-coalesced ref actually updated (the frame that lost the
   *  coalescing race never gets this stamp). */
  tDisplay?: number;
  // A-P12: the client-only `source` stream address was removed from this WIRE
  // type — it never crossed the wire and is now carried out-of-band by the
  // renderer's `FrameRef` (`useSession().frame()` → `{ payload, source }`),
  // keeping `FrameMeta` transport-only.
};

export type ShmFrameRef = {
  seg: string;
  gen: number;
  seq: bigint;
  retries?: number;
};

/** Raw frame payload as it crosses the process boundary. */
export type FramePayload = {
  data?: ArrayBuffer;
  shape: number[];
  channels: number;
  meta?: FrameMeta;
  shm?: ShmFrameRef;
};

export type FrameCounterStats = {
  offered: number;
  sent: number;
  coalesced: number;
  bytes: number;
};

export type FrameTimingStats = SampleStats;

export type FrameTopicStats = FrameCounterStats & {
  window: {
    startedAt: number;
    snapshotAt: number;
    uptimeMs: number;
  };
  rates: {
    offeredPerSec: number;
    sentPerSec: number;
    coalescedPerSec: number;
    bytesPerSec: number;
  };
  timing: {
    convertMs: FrameTimingStats;
  };
};

// --- Contract -----------------------------------------------------------

/** A typed command signature; `cmd<Arg, Ret>()` is a phantom value (no logic
 *  ships to the renderer) used only to carry the types. */
export type Command<Arg = void, Ret = void> = { arg: Arg; ret: Ret };

export function cmd<Arg = void, Ret = void>(): Command<Arg, Ret> {
  return undefined as unknown as Command<Arg, Ret>;
}

/**
 * The single source of truth for one session, importable by both processes.
 * `state` / `telemetry` carry runtime initial values (used as renderer ref
 * seeds and server defaults); `frames` lists channel names; `commands` is types
 * only via {@link cmd}.
 */
export type Contract = {
  state: Record<string, Serializable>;
  telemetry: Record<string, Serializable>;
  frames: readonly string[];
  commands: Record<string, Command<any, any>>;
};

export function defineContract<C extends Contract>(contract: C): C {
  return contract;
}

export type StateOf<C extends Contract> = C["state"];
export type TelemetryOf<C extends Contract> = C["telemetry"];
export type FrameOf<C extends Contract> = C["frames"][number];
export type CommandsOf<C extends Contract> = C["commands"];

// --- Wire format --------------------------------------------------------

type Req = { k: "req"; id: number; m: string; p: any };
type Res = { k: "res"; id: number; ok: boolean; v?: any; e?: string };
type Evt = { k: "evt"; t: string; d: any };
type Frame = { k: "frame"; t: string; f: FramePayload };
// Frame acknowledgement — the receiver returns one per delivered frame so the
// sender can keep at most one frame in flight per topic (latest-wins drop).
type Fack = { k: "fack"; t: string };
// C10 (docs/refactor/orchestrator.md §7.1 item 3): a client declares interest
// in a frame topic once, when it first opens that topic's ref — the sender
// only calls `sendFrame` for channels that declared interest, instead of
// broadcasting every frame topic to every session subscriber regardless of
// whether that window ever reads it. Never "undeclared" (bounded by each
// session's small fixed `frames` list — see `Channel.declareFrameInterest`).
type FrameInterest = { k: "finterest"; t: string };
type Wire = Req | Res | Evt | Frame | Fack | FrameInterest;

export type SessionSubscription = {
  name: string;
  passive?: boolean;
};

export type SessionSubscriptionPayload = string | SessionSubscription;

/** Minimal duplex an `Endpoint` must provide; adapters wrap DOM and Electron
 *  ports onto this shape (see client.ts / orchestrator/runtime.ts). */
export interface Endpoint {
  post(data: Wire, transfer?: Transferable[]): void;
  onMessage(cb: (data: Wire) => void): void;
  close?(): void;
}

type Handler = (params: any) => any;
type Listener = (data: any) => void;
type FrameListener = (payload: FramePayload) => void;

export class Channel {
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  private readonly handlers = new Map<string, Handler>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly frameListeners = new Map<string, Set<FrameListener>>();
  // Backpressure (sender side): topics with a frame awaiting its ack, and the
  // latest payload deferred until that ack arrives (older ones are dropped).
  private readonly frameInflight = new Set<string>();
  private readonly framePending = new Map<string, FramePayload>();
  // Per-topic send counter for `FrameMeta.seq` — incremented on every
  // `sendFrame` call, including ones later overwritten in `framePending`, so
  // gaps in the *received* sequence measure exactly what the backpressure
  // gate dropped.
  private readonly frameSeq = new Map<string, number>();
  // Per-topic send/coalesce/byte counters (perf substrate, §7.3 item 3) —
  // sender-side ground truth; the receiver's inspector OSD only *infers*
  // drops from `seq` gaps, so the two cross-check each other.
  private readonly frameStats = new Map<
    string,
    FrameCounterStats
  >();
  private readonly frameTiming = new Map<string, { convertMs: RollingStats }>();
  private readonly statsStartedAt = Date.now();
  // C10: topics this channel's *peer* has declared interest in (frames sent
  // by this Channel are gated on it; frames received don't consult it).
  private readonly frameInterest = new Set<string>();
  // V4 (docs/refactor/orchestrator.md §7.1): fired whenever a peer declares
  // interest in a topic — `ServerSession.attach()` uses this to replay a
  // cached last-payload for one-shot frame resources (e.g. a capture
  // preview) to a channel that opens its ref *after* the frame was already
  // published. Plain listener set, same shape as `.on()`/`.onFrame()`.
  private readonly frameInterestListeners = new Set<(t: string) => void>();

  constructor(private readonly endpoint: Endpoint) {
    endpoint.onMessage((msg) => this.dispatch(msg));
  }

  /** Declare interest in a frame topic — call once, when first opening that
   *  topic's ref (see `client.ts`'s `frame()`). Idempotent. */
  declareFrameInterest(topic: string): void {
    this.endpoint.post({ k: "finterest", t: topic });
  }

  /** Whether the peer has declared interest in this frame topic (C10). A
   *  session should skip `sendFrame` entirely for uninterested channels —
   *  not just to save bandwidth, but to keep `stats()` honest ("sent" means
   *  "sent to someone who asked for it"). */
  hasFrameInterest(topic: string): boolean {
    return this.frameInterest.has(topic);
  }

  /** Subscribe to every `finterest` declaration this channel receives, for
   *  any topic — callers filter by their own topic prefix. Returns an
   *  unsubscribe. */
  onFrameInterest(fn: (topic: string) => void): () => void {
    this.frameInterestListeners.add(fn);
    return () => this.frameInterestListeners.delete(fn);
  }

  /** Per-topic frame counters since the last read — offered (every
   *  `sendFrame` call), sent (actually posted on the wire), coalesced (an
   *  earlier offer overwritten by a newer one before it could be sent), and
   *  bytes sent. */
  stats(topic: string): FrameCounterStats {
    return this.frameStats.get(topic) ?? { offered: 0, sent: 0, coalesced: 0, bytes: 0 };
  }

  /** Every topic this channel has recorded stats for — `Hub.perfSnapshot`
   *  aggregates these across every connection. */
  allFrameStats(now = Date.now()): Record<string, FrameTopicStats> {
    const out: Record<string, FrameTopicStats> = {};
    for (const [topic, counters] of this.frameStats) {
      const window = snapshotWindow(this.statsStartedAt, now);
      out[topic] = {
        ...counters,
        window,
        rates: {
          offeredPerSec: ratePerSec(counters.offered, window),
          sentPerSec: ratePerSec(counters.sent, window),
          coalescedPerSec: ratePerSec(counters.coalesced, window),
          bytesPerSec: ratePerSec(counters.bytes, window),
        },
        timing: {
          convertMs: this.timingSnapshot(topic, "convertMs"),
        },
      };
    }
    return out;
  }

  private touchStats(topic: string): {
    offered: number;
    sent: number;
    coalesced: number;
    bytes: number;
  } {
    let s = this.frameStats.get(topic);
    if (!s) this.frameStats.set(topic, (s = { offered: 0, sent: 0, coalesced: 0, bytes: 0 }));
    return s;
  }

  private timing(topic: string): { convertMs: RollingStats } {
    let s = this.frameTiming.get(topic);
    if (!s) this.frameTiming.set(topic, (s = { convertMs: new RollingStats(0.9, 2, "ms") }));
    return s;
  }

  private timingSnapshot(
    topic: string,
    key: keyof ReturnType<Channel["timing"]>,
  ): FrameTimingStats {
    const s = this.frameTiming.get(topic)?.[key];
    return s ? { count: s.count, mean: s.mean, max: s.max } : { count: 0, mean: 0, max: 0 };
  }

  /** Issue a request and await its response. */
  request<T = any>(method: string, params?: any): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.endpoint.post({ k: "req", id, m: method, p: params });
    });
  }

  /** Register the single handler for an incoming request method. */
  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  /** Subscribe to an event topic; returns an unsubscribe. */
  on(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(topic: string, data: any): void {
    this.endpoint.post({ k: "evt", t: topic, d: data });
  }

  /** Subscribe to a frame topic; returns an unsubscribe. */
  onFrame(topic: string, fn: FrameListener): () => void {
    let set = this.frameListeners.get(topic);
    if (!set) this.frameListeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  sendFrame(topic: string, payload: FramePayload): void {
    const stats = this.touchStats(topic);
    stats.offered++;
    const seq = (this.frameSeq.get(topic) ?? 0) + 1;
    this.frameSeq.set(topic, seq);
    const stamped = withFrameMeta(payload, { tCapture: Date.now() }, payload.meta, {
      seq,
    });
    if (typeof stamped.meta?.convertMs === "number")
      this.timing(topic).convertMs.push(stamped.meta.convertMs);
    // Never queue frames toward a slow receiver: hold one in flight per topic
    // and keep only the latest while we wait for its ack (lossy, latest-wins).
    if (this.frameInflight.has(topic)) {
      // An existing pending frame, if any, is discarded (never sent) in favor
      // of this newer one — that's exactly "coalesced away."
      if (this.framePending.has(topic)) stats.coalesced++;
      this.framePending.set(topic, stamped);
      return;
    }
    this.frameInflight.add(topic);
    this.postFrame(topic, stamped);
  }

  /** Stamp `tPublish` at the actual wire-send instant (not at `sendFrame`
   *  call time — a coalesced frame sits in `framePending` first) and post. */
  private postFrame(topic: string, payload: FramePayload): void {
    payload.meta!.tPublish = Date.now();
    const stats = this.touchStats(topic);
    stats.sent++;
    stats.bytes += payload.data?.byteLength ?? 0;
    const transfer = payload.data ? [payload.data] : [];
    this.endpoint.post({ k: "frame", t: topic, f: payload }, transfer);
  }

  /** An ack arrived: flush the deferred latest frame, or clear the gate. */
  private onFrameAck(topic: string): void {
    const pending = this.framePending.get(topic);
    if (pending) {
      this.framePending.delete(topic);
      this.postFrame(topic, pending);
    } else {
      this.frameInflight.delete(topic);
    }
  }

  close(): void {
    this.frameInflight.clear();
    this.framePending.clear();
    // Reject in-flight requests instead of leaving callers hanging forever —
    // without this, a dead orchestrator (crash/restart) strands every pending
    // `call()` (e.g. one awaited inside a suspense-mounted module). See
    // docs/refactor/orchestrator.md §12.1 C5.
    for (const p of this.pending.values())
      p.reject(new Error("Channel closed"));
    this.pending.clear();
    this.endpoint.close?.();
  }

  private async dispatch(msg: Wire): Promise<void> {
    switch (msg.k) {
      case "req": {
        const fn = this.handlers.get(msg.m);
        if (!fn) {
          this.endpoint.post({
            k: "res",
            id: msg.id,
            ok: false,
            e: `No handler for "${msg.m}"`,
          });
          return;
        }
        try {
          const v = await fn(msg.p);
          this.endpoint.post({ k: "res", id: msg.id, ok: true, v });
        } catch (e) {
          this.endpoint.post({
            k: "res",
            id: msg.id,
            ok: false,
            e: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case "res": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.v);
        else p.reject(new Error(msg.e));
        return;
      }
      case "evt": {
        this.listeners.get(msg.t)?.forEach((fn) => fn(msg.d));
        return;
      }
      case "frame": {
        // Ack first so the sender can release its gate while we fan out; the
        // renderer's own rAF coalescing throttles actual display work.
        this.endpoint.post({ k: "fack", t: msg.t });
        this.frameListeners.get(msg.t)?.forEach((fn) => fn(msg.f));
        return;
      }
      case "fack": {
        this.onFrameAck(msg.t);
        return;
      }
      case "finterest": {
        this.frameInterest.add(msg.t);
        for (const fn of this.frameInterestListeners) fn(msg.t);
        return;
      }
    }
  }
}

// --- Topic helpers (shared so both ends agree on the wire strings) -------

/** Per-session status snapshot (A-P13). `error` is the current user-visible
 *  failure (e.g. a failed activation / camera contention), or null when healthy. */
export type SessionStatus = { error: string | null };

export const topic = {
  state: (session: string) => `st:${session}`,
  telemetry: (session: string) => `tel:${session}`,
  // Per-session status (A-P13): the current user-visible failure, if any.
  // Seeded to every new subscriber like state/telemetry, so an activation
  // failure that happened before a window opened is still shown. Payload is a
  // `SessionStatus`.
  status: (session: string) => `sts:${session}`,
  frame: (session: string, name: string) => `fr:${session}:${name}`,
  command: (session: string, name: string) => `cmd:${session}:${name}`,
  setState: (session: string) => `set:${session}`,
  // Per-session interest. Payload is either the legacy session name or
  // `{ name, passive?: boolean }`; passive observers receive state/telemetry
  // without counting toward session activation.
  subscribe: "__sub__",
  unsubscribe: "__unsub__",
  // Process-wide diagnostic broadcast (not per-session — some failures, like a
  // camera-registry sink throw, have no single owning session). Payload is
  // `{ scope: string, message: string }`.
  error: "__err__",
  // Structured timing measurement broadcast (§7.1 S5) — payload is a `Span`
  // (`orchestrator/diagnostics.ts`), fired live as each one is recorded so a
  // future profiler window can render a timeline without polling.
  span: "__span__",
};
