// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Server-side session runtime. A `ServerSession` owns the authoritative state
// for one contract, runs its command handlers and control loop, and broadcasts
// state / telemetry / frames to every attached client channel. The `Hub`
// multiplexes all sessions onto each renderer connection.

import type { MessagePortMain } from "electron";
import {
  Channel,
  topic,
  type CommandsOf,
  type Contract,
  type Endpoint,
  type FrameMeta,
  type FramePayload,
  type FrameOf,
  type FrameTopicStats,
  type SessionStatus,
  type SessionSubscriptionPayload,
  type StateOf,
  type TelemetryOf,
} from "../lib/orchestrator/protocol.js";
import {
  pendingList,
  withStepState,
  type ProgressItem,
  type ProgressMonitor,
  type ProgressStep,
} from "../lib/orchestrator/progress.js";
import { report, span, type ReportLevel, type Span } from "./diagnostics.js";
import type {
  FrameTransport,
  SessionFrameSource,
} from "./frame-transport.js";

function mainEndpoint(port: MessagePortMain): Endpoint {
  return {
    // MessagePortMain.postMessage only transfers MessagePortMain objects — not
    // ArrayBuffers — so the transfer list is dropped here; frame buffers cross
    // to the renderer via structured clone (a copy). Passing the buffer in the
    // transfer list throws "Port at index 0 is not a valid port".
    post: (data) => port.postMessage(data),
    onMessage: (cb) => port.on("message", (e) => cb(e.data)),
    close: () => port.close(),
  };
}

type FrameTransportFactory = () => FrameTransport;

let frameTransportFactory: FrameTransportFactory = () => {
  throw new Error("No frame transport configured");
};

function cloneDefault<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  if (Array.isArray(value)) return value.map((v) => cloneDefault(v)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneDefault(v)]),
    ) as T;
  return value;
}

export function setFrameTransportFactory(factory: FrameTransportFactory): void {
  frameTransportFactory = factory;
}

export class ServerSession<C extends Contract> {
  /** Authoritative state, seeded from the contract defaults. */
  readonly state: StateOf<C>;
  private readonly telemetryDefaults: Record<string, any>;
  // Merged telemetry snapshot (patches applied on top of contract defaults) —
  // needed so a subscriber arriving after a one-shot publish (e.g. `ready`,
  // `list`, `connected`) still sees it, instead of waiting for the next patch
  // that may never come.
  private readonly telemetrySnapshot: Record<string, any>;
  // Current user-visible failure (e.g. a failed activation), seeded to
  // new subscribers like the telemetry snapshot so a failure that happened
  // before a window opened is still shown, not lost to stderr.
  private readonly statusSnapshot: SessionStatus = { error: null, progress: null };
  // Ownership token for the CURRENT progressMonitor — stale handles are inert.
  private activeMonitor: symbol | null = null;
  private readonly channels = new Set<Channel>(); // attached (command-capable)
  private readonly subscribers = new Set<Channel>(); // observers (state/telemetry/frames)
  private readonly activeSubscribers = new Set<Channel>(); // activation interest
  // Last payload per frame topic, so a one-shot resource (e.g. a capture
  // preview, published exactly once) still reaches a channel that only opens
  // its `frame(name)` ref *after* the publish — otherwise it's silently
  // dropped (no listener yet client-side, and the demand gate wouldn't even
  // attempt the send). Bounded by clearing on idle/dispose, not by topic
  // count — dynamic per-capture channel names would otherwise accumulate forever.
  private readonly frameCache = new Map<string, FramePayload>();
  // Timestamp of the most recent
  // activation (subscribers 0 -> 1), cleared once the first frame after it
  // publishes — measures "activate -> first frame" ("time to live stream")
  // generically for every session, without per-module instrumentation.
  private activatedAt: number | null = null;
  private readonly commands = new Map<
    string,
    (arg: any, ctx?: { channel: Channel }) => any
  >();
  private readonly stateWatchers = new Set<(key: string, value: any) => void>();
  private frameTransport: FrameTransport | null = null;
  private activateFn?: () => void;
  private idleFn?: () => void | Promise<void>;
  private busyFn?: () => string | null;
  // Latest idle settlement (multi-window drain): an async `idle` (e.g. manual-control's
  // capture/recording drain) returns a promise; `drained()` awaits it so
  // "closed" can mean session-idle-drained, not merely window-destroyed.
  private lastIdle: Promise<void> = Promise.resolve();

  constructor(
    readonly name: string,
    contract: C,
  ) {
    this.state = { ...contract.state } as StateOf<C>;
    this.telemetryDefaults = cloneDefault(contract.telemetry);
    this.telemetrySnapshot = cloneDefault(this.telemetryDefaults);
  }

  /** Register a command handler (called when a client invokes it). The
   *  optional second arg carries the CALLING channel (compose validates
   *  the caller's authoritative windowId via `hub.windowIdOf(ctx.channel)`);
   *  existing single-param handlers are unaffected. */
  command<K extends keyof CommandsOf<C>>(
    name: K,
    handler: (
      arg: CommandsOf<C>[K]["arg"],
      ctx?: { channel: Channel },
    ) => CommandsOf<C>[K]["ret"] | Promise<CommandsOf<C>[K]["ret"]>,
  ): this {
    this.commands.set(String(name), handler);
    return this;
  }

  /** React to a renderer changing an authoritative state field. */
  onState(fn: (key: string, value: any) => void): this {
    this.stateWatchers.add(fn);
    return this;
  }

  /** Called when the first renderer subscribes (resume/start resources). */
  onActivate(fn: () => void): this {
    this.activateFn = fn;
    return this;
  }

  /** Called when the last renderer unsubscribes (release session resources).
   *  May return a promise — `drained()` awaits the latest one. */
  onIdle(fn: () => void | Promise<void>): this {
    this.idleFn = fn;
    return this;
  }

  /** Register the busy probe (drain refusal) — see `busyReason()`. */
  onBusyCheck(fn: () => string | null): this {
    this.busyFn = fn;
    return this;
  }

  /** Non-null = this session must not be force-drained right now (e.g.
   *  mid-capture/recording); the string is the user-facing reason. */
  busyReason(): string | null {
    return this.busyFn?.() ?? null;
  }

  /** Resolves once the most recent idle (if any) has fully settled — camera
   *  leases released, capture/recording drained. Resolved when never idled. */
  drained(): Promise<void> {
    return this.lastIdle;
  }

  private runIdle(): void {
    // A teardown (last window closed, or a forced
    // drain / dispose) must never leave a stale progress overlay for the next
    // subscriber — clear it (and orphan any outstanding monitor handle) before
    // the module's own idle hook runs.
    this.activeMonitor = null;
    if (this.statusSnapshot.progress !== null) this.setProgress(null);
    const r = this.idleFn?.();
    // Swallow (but log) idle failures — a rejected drain must not wedge
    // `drained()` awaiters or the switch path.
    if (r) this.lastIdle = Promise.resolve(r).catch((e) => report(this.name, `idle: ${e}`));
  }

  setState<K extends keyof StateOf<C>>(key: K, value: StateOf<C>[K]): void {
    this.state[key] = value;
    const patch = { key: String(key), value };
    for (const ch of this.subscribers) ch.emit(topic.state(this.name), patch);
  }

  telemetry(patch: Partial<TelemetryOf<C>>): void {
    Object.assign(this.telemetrySnapshot, patch);
    for (const ch of this.subscribers)
      ch.emit(topic.telemetry(this.name), patch);
  }

  /** Republish telemetry defaults declared on the contract. With `keys`, only
   *  those fields reset; without it, the whole contract telemetry shape resets.
   *  Values come from the contract defaults, not hand-written session mirrors. */
  resetTelemetry<K extends keyof TelemetryOf<C>>(keys?: readonly K[]): void {
    const patch: Partial<TelemetryOf<C>> = {};
    const names = keys?.map(String) ?? Object.keys(this.telemetryDefaults);
    for (const key of names) (patch as any)[key] = cloneDefault(this.telemetryDefaults[key]);
    this.telemetry(patch);
  }

  /** Report a user-visible session failure (e.g. a failed activation / camera
   *  contention) — logged locally AND pushed to every subscriber on the status
   *  channel, and seeded to future subscribers, so it's visible without
   *  watching the orchestrator console. */
  fail(reason: string): void {
    this.statusSnapshot.error = reason;
    report(this.name, reason);
    this.broadcastStatus();
  }

  /** Clear the current session error (a retry succeeded, or the UI dismissed
   *  it). No-op when already clear. */
  clearError(): void {
    if (this.statusSnapshot.error === null) return;
    this.statusSnapshot.error = null;
    this.broadcastStatus();
  }

  // Emit a COPY of the status snapshot — never the mutable snapshot itself, so
  // a later `fail`/`clearError` can't retro-alter an already-queued message.
  private broadcastStatus(): void {
    for (const ch of this.subscribers)
      ch.emit(topic.status(this.name), { ...this.statusSnapshot });
  }

  /** Seed the current progress list into the snapshot and push it, or clear it
   *  (null). Rides the same status channel as `error`, so it's seeded to future
   *  subscribers too (a window opened mid-activation still sees the overlay). */
  private setProgress(progress: ProgressItem[] | null): void {
    this.statusSnapshot.progress = progress;
    this.broadcastStatus();
  }

  /**
   * Declare an ORCHESTRATOR SPIN-UP progress monitor:
   * a session names its activation steps UPFRONT, then transitions each one as
   * it works, so any subscribed window can render a progress overlay instead of
   * a blank screen while the graph builds. Declaring publishes the full pending
   * list immediately; `start`/`done` publish single transitions; `complete`
   * clears it (progress → null). A FAILURE path calls neither `done` nor
   * `complete`: the frozen list shows WHERE spin-up died (the error surfaces
   * separately via `fail()`). Idle teardown (`runIdle`) also clears progress —
   * a cancelled/superseded spin-up never leaves a stale overlay behind.
   */
  progressMonitor(steps: readonly ProgressStep[]): ProgressMonitor {
    // A superseded activation can hold its monitor past an await and fire a
    // late `start`/`done` AFTER idle teardown cleared the snapshot — or after
    // the replacing activation declared its own list. A stale handle must be
    // INERT (not merely detached), or it resurrects/clobbers the overlay:
    // only the CURRENT monitor may publish.
    const mine = Symbol("progress-monitor");
    this.activeMonitor = mine;
    let items = pendingList(steps);
    this.setProgress(items);
    const publish = (next: ProgressItem[] | null): void => {
      if (this.activeMonitor === mine) this.setProgress(next);
    };
    return {
      start: (id) => publish((items = withStepState(items, id, "active"))),
      done: (id) => publish((items = withStepState(items, id, "done"))),
      complete: () => publish(null),
    };
  }

  /** @deprecated Alias of `fail()` — kept for callers that read as "report an
   *  error". Both log + surface to the renderer. */
  error(message: string): void {
    this.fail(message);
  }

  // `string & {}` allows dynamic channels (e.g. one per camera serial) while
  // keeping autocomplete for the contract's static frame names.
  //
  // Only send to subscribers that declared interest in *this* topic — a session
  // subscriber that never opened `frame(name)` for it shouldn't pay the
  // structured-clone + backpressure-gate cost for a topic it never reads.
  frame(
    name: FrameOf<C> | (string & {}),
    source: SessionFrameSource,
    meta?: FrameMeta,
  ): void {
    const t = topic.frame(this.name, String(name));
    const payload = this.getFrameTransport().write(t, source, meta);
    this.frameCache.set(t, payload); // last-payload cache, replayed on late interest
    if (this.activatedAt !== null) {
      span(`session.${this.name}.timeToFirstFrame`, performance.now() - this.activatedAt);
      this.activatedAt = null;
    }
    for (const ch of this.subscribers) if (ch.hasFrameInterest(t)) ch.sendFrame(t, payload);
  }

  // Sessions gating an EXPENSIVE producer (the template-match diagnostic
  // heatmap) on real demand need the aggregate per-topic interest the demand
  // machinery already tracks per channel. Coarse change notifications —
  // listeners re-derive via
  // `frameInterested` (interest is only ever gained per channel and lost by
  // channel departure, so "something changed" is enough signal).
  private readonly frameInterestListeners = new Set<() => void>();

  /** Whether ANY current subscriber declared interest in the named frame. */
  frameInterested(name: FrameOf<C> | (string & {})): boolean {
    const t = topic.frame(this.name, String(name));
    for (const ch of this.subscribers) if (ch.hasFrameInterest(t)) return true;
    return false;
  }

  /** Fires when the interest set MAY have changed (a channel declared a new
   *  frame interest, or a subscriber departed). Returns an unsubscribe. */
  onFrameInterestChange(cb: () => void): () => void {
    this.frameInterestListeners.add(cb);
    return () => this.frameInterestListeners.delete(cb);
  }

  private notifyFrameInterestChange(): void {
    for (const cb of this.frameInterestListeners) cb();
  }

  /** Wire one client connection to this session (commands + state writes). */
  attach(ch: Channel): void {
    this.channels.add(ch);
    for (const [cname, fn] of this.commands)
      ch.handle(topic.command(this.name, cname), (arg: unknown) =>
        fn(arg, { channel: ch }),
      );
    // Replay a cached last-payload to a channel that declares interest
    // in a frame topic *after* it was already published — see `frame()`.
    // Every session attached to `ch` gets this callback; a lookup miss for a
    // topic another session owns is just a harmless no-op.
    ch.onFrameInterest((t) => {
      const cached = this.frameCache.get(t);
      if (cached) ch.sendFrame(t, cached);
      this.notifyFrameInterestChange(); // demand-gated producers re-derive
    });
    // setState is a fire-and-forget event from the client (the value echoes
    // back via the `state` topic), so listen with `on`, not `handle`.
    ch.on(topic.setState(this.name), ({ key, value }) => {
      (this.state as any)[key] = value;
      for (const fn of this.stateWatchers) fn(key, value);
      // Echo to every *other* interested window so multi-window views stay
      // consistent. Skip the originating channel: it already applied the
      // value optimistically, so its own echo is pure round-trip — and on a
      // rapid sequence of writes (e.g. a slider drag), that echo can arrive
      // after a newer local write and transiently clobber it back to the
      // stale value.
      for (const peer of this.subscribers)
        if (peer !== ch) peer.emit(topic.state(this.name), { key, value });
    });
  }

  detach(ch: Channel): void {
    this.channels.delete(ch);
    this.unsubscribe(ch);
  }

  /** A renderer began observing this session: seed it and optionally activate. */
  subscribe(ch: Channel, options: { passive?: boolean } = {}): void {
    if (!this.subscribers.has(ch)) {
      this.subscribers.add(ch);
      // Seed the new subscriber with the current state + telemetry snapshot —
      // without the telemetry seed, one-shot keys (`ready`, `list`, `connected`)
      // published before this subscriber arrived would never reach it.
      for (const key of Object.keys(this.state))
        ch.emit(topic.state(this.name), { key, value: (this.state as any)[key] });
      ch.emit(topic.telemetry(this.name), this.telemetrySnapshot);
      ch.emit(topic.status(this.name), { ...this.statusSnapshot }); // A-P13: seed error state
    }
    if (options.passive || this.activeSubscribers.has(ch)) return;
    const wasIdle = this.activeSubscribers.size === 0;
    this.activeSubscribers.add(ch);
    if (wasIdle) {
      this.activatedAt = performance.now();
      // Fresh activation attempt clears any stale failure; a failing
      // `activate()` re-sets it via `fail()`. Gives retry-on-reactivate.
      this.clearError();
      this.activateFn?.();
    }
  }

  /** A renderer stopped observing; release resources when active interest ends. */
  unsubscribe(ch: Channel, options: { passive?: boolean } = {}): void {
    if (options.passive && this.activeSubscribers.has(ch)) return;
    const wasActive = this.activeSubscribers.delete(ch);
    const wasSubscriber = this.subscribers.delete(ch);
    if (wasSubscriber) this.notifyFrameInterestChange(); // interest may have shrunk
    if (wasActive && this.activeSubscribers.size === 0) {
      this.runIdle();
      this.clearFrameCache(); // bound memory — stale previews from this activation are gone anyway
    }
  }

  private clearFrameCache(): void {
    this.frameCache.clear();
    this.frameTransport?.close();
    this.frameTransport = null;
  }

  private getFrameTransport(): FrameTransport {
    return (this.frameTransport ??= frameTransportFactory());
  }

  /**
   * Force-release session resources regardless of current active count —
   * used both for orchestrator shutdown and for handing exclusive hardware
   * access back to a non-migrated renderer module. Clearing
   * interest sets (not just calling `idleFn`) matters: without it, a later
   * genuine subscribe from a still-mounted client wouldn't re-fire
   * `activateFn` (the count would never have returned to zero).
   */
  dispose(): void {
    const wasActive = this.activeSubscribers.size > 0;
    this.subscribers.clear();
    this.activeSubscribers.clear();
    if (wasActive) this.runIdle();
    this.clearFrameCache();
  }
}

function parseSubscriptionPayload(
  payload: SessionSubscriptionPayload,
): { name: string; passive?: boolean } {
  if (typeof payload === "string") return { name: payload };
  return { name: payload.name, passive: payload.passive };
}

/**
 * Declarative session shape checked against the contract: `commands` must
 * implement every command the contract declares (missing/mistyped = compile
 * error — no more stringly-dispatched `session.command("name", fn)` calls),
 * and `watch` is typed per state key instead of a manually-`switch`ed
 * `(key, value)` callback. `build` receives the already-constructed
 * `ServerSession` so handlers can close over `s.state`/`s.telemetry`/`s.frame`/
 * `s.error` — the same object `defineSession` returns.
 */
export interface SessionDefinition<C extends Contract> {
  /** First renderer subscribed — (re)start session-owned resources. */
  activate?(): void;
  /** Last renderer unsubscribed — release session-owned resources. Return a
   *  promise when the release is async (capture/recording drain) so the
   *  multi-window drain path can await settlement via `drained()`. */
  idle?(): void | Promise<void>;
  /** Optional busy probe for the drain path: return a user-facing reason
   *  (e.g. "capture in progress") to refuse a force-drain, or null. */
  busy?(): string | null;
  commands: {
    [K in keyof CommandsOf<C>]: (
      arg: CommandsOf<C>[K]["arg"],
    ) => CommandsOf<C>[K]["ret"] | Promise<CommandsOf<C>[K]["ret"]>;
  };
  /** Per-key reaction to a renderer changing authoritative state. */
  watch?: {
    [K in keyof StateOf<C>]?: (value: StateOf<C>[K], key: K) => void;
  };
}

export function defineSession<C extends Contract>(
  name: string,
  contract: C,
  build: (s: ServerSession<C>) => SessionDefinition<C>,
): ServerSession<C> {
  const session = new ServerSession(name, contract);
  const def = build(session);
  for (const key of Object.keys(def.commands) as (keyof CommandsOf<C>)[])
    session.command(key, def.commands[key]);
  if (def.watch) {
    const watch = def.watch;
    session.onState((key, value) => (watch as any)[key]?.(value, key));
  }
  if (def.activate) session.onActivate(def.activate);
  if (def.idle) session.onIdle(def.idle);
  if (def.busy) session.onBusyCheck(def.busy);
  return session;
}

/** Owns every session and attaches them to each incoming client port. */
export class Hub {
  private readonly sessions: ServerSession<any>[] = [];
  private readonly byName = new Map<string, ServerSession<any>>();
  private readonly channels = new Set<Channel>();
  // Channel → stable windowId (from the main-process connect handshake).
  // The composition validation keys `win/<windowId>/...` requests on it.
  private readonly channelWindows = new Map<Channel, string>();
  private readonly windowClosedHooks = new Set<(windowId: string) => void>();
  // Per-CHANNEL teardown hooks. Unlike `windowClosed` (DESTROY only), these
  // fire on every port close — reload, renderer crash, and window close alike —
  // so a session holding per-channel native refcounts (the pipe broker's
  // connect ledger) can reconcile them when the renderer that took them goes
  // away, instead of wedging the consumer gate ON forever.
  private readonly channelClosedHooks = new Set<(ch: Channel) => void>();

  add<C extends Contract>(session: ServerSession<C>): ServerSession<C> {
    this.sessions.push(session);
    this.byName.set(session.name, session);
    return session;
  }

  /** The stable windowId a channel's window carries, if the connect
   *  handshake supplied one. Undefined for untagged/legacy connections. */
  windowIdOf(ch: Channel): string | undefined {
    return this.channelWindows.get(ch);
  }

  /** Register a window-close hook: fires with the closed window's
   *  stable id when the MAIN process reports the BrowserWindow destroyed —
   *  the authoritative teardown signal for per-window state (a mere channel
   *  close also happens on RELOAD, where the windowId lives on). Returns an
   *  unregister disposer. */
  onWindowClosed(fn: (windowId: string) => void): () => void {
    this.windowClosedHooks.add(fn);
    return () => this.windowClosedHooks.delete(fn);
  }

  /** Main reported a window destroyed — dispatch the teardown hooks. */
  windowClosed(windowId: string): void {
    for (const fn of this.windowClosedHooks) fn(windowId);
  }

  /** Register a channel-close hook: fires with the
   *  Channel whenever its client port closes — reload, crash, or window close.
   *  The authoritative signal for reconciling per-channel native state (e.g.
   *  the pipe broker's connect refcounts). Returns an unregister disposer. */
  onChannelClosed(fn: (ch: Channel) => void): () => void {
    this.channelClosedHooks.add(fn);
    return () => this.channelClosedHooks.delete(fn);
  }

  attach(port: MessagePortMain, meta?: { windowId?: string | null }): void {
    port.start();
    const ch = new Channel(mainEndpoint(port));
    this.channels.add(ch);
    if (meta?.windowId) this.channelWindows.set(ch, meta.windowId);
    for (const s of this.sessions) s.attach(ch);
    // Config-store RPC no longer rides the orchestrator channel — renderer
    // `Store` clients talk to MAIN directly (config-store-main-authority.md).
    // Per-session interest: route subscribe/unsubscribe to the named session.
    ch.on(topic.subscribe, (payload: SessionSubscriptionPayload) => {
      const { name, passive } = parseSubscriptionPayload(payload);
      this.byName.get(name)?.subscribe(ch, { passive });
    });
    ch.on(topic.unsubscribe, (payload: SessionSubscriptionPayload) => {
      const { name, passive } = parseSubscriptionPayload(payload);
      this.byName.get(name)?.unsubscribe(ch, { passive });
    });
    port.on("close", () => {
      // Reconcile per-channel native state (pipe connect refcounts) BEFORE the
      // sessions detach — the hooks still need to look the channel up.
      for (const fn of this.channelClosedHooks) fn(ch);
      for (const s of this.sessions) s.detach(ch);
      this.channels.delete(ch);
      this.channelWindows.delete(ch);
      ch.close(); // rejects any pending outbound requests, clears frame gate state
    });
  }

  /** Release every session's resources (called on orchestrator shutdown). */
  shutdown(): void {
    for (const s of this.sessions) s.dispose();
  }

  /** Broadcast a diagnostic error to every connected renderer, regardless of
   *  session subscription — for failures with no single owning session (e.g.
   *  the shared camera registry). */
  reportError(scope: string, message: string, level: ReportLevel = "error"): void {
    for (const ch of this.channels) ch.emit(topic.error, { scope, message, level });
  }

  /** Broadcast a `Span` to every connected renderer, live, the same
   *  way `reportError` broadcasts diagnostics — a future profiler window
   *  consumes this for a real-time timeline. */
  reportSpan(s: Span): void {
    for (const ch of this.channels) ch.emit(topic.span, s);
  }

  /** Per-topic frame stats summed across every connected channel (perf
   *  substrate — `system.perfSnapshot` aggregates this). */
  frameStatsSnapshot(): Record<
    string,
    FrameTopicStats
  > {
    const merged: Record<string, FrameTopicStats> = {};
    const timing = (count = 0, mean = 0, max = 0) => ({ count, mean, max });
    for (const ch of this.channels) {
      for (const [t, s] of Object.entries(ch.allFrameStats())) {
        const m = (merged[t] ??= {
          offered: 0,
          sent: 0,
          coalesced: 0,
          bytes: 0,
          window: { startedAt: s.window.startedAt, snapshotAt: s.window.snapshotAt, uptimeMs: s.window.uptimeMs },
          rates: { offeredPerSec: 0, sentPerSec: 0, coalescedPerSec: 0, bytesPerSec: 0 },
          timing: { convertMs: timing() },
        });
        m.offered += s.offered;
        m.sent += s.sent;
        m.coalesced += s.coalesced;
        m.bytes += s.bytes;
        m.window.startedAt = Math.min(m.window.startedAt, s.window.startedAt);
        m.window.snapshotAt = Math.max(m.window.snapshotAt, s.window.snapshotAt);
        m.window.uptimeMs = Math.max(m.window.uptimeMs, s.window.uptimeMs);
        const tc = s.timing.convertMs;
        const mc = m.timing.convertMs;
        if (tc.count > 0) {
          const total = mc.count + tc.count;
          mc.mean = total === 0 ? 0 : (mc.mean * mc.count + tc.mean * tc.count) / total;
          mc.count = total;
          mc.max = Math.max(mc.max, tc.max);
        }
      }
    }
    for (const m of Object.values(merged)) {
      const sec = Math.max(0.001, m.window.uptimeMs / 1000);
      m.rates = {
        offeredPerSec: m.offered / sec,
        sentPerSec: m.sent / sec,
        coalescedPerSec: m.coalesced / sec,
        bytesPerSec: m.bytes / sec,
      };
    }
    return merged;
  }
}
