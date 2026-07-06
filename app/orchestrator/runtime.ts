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
  type FramePayload,
  type FrameOf,
  type FrameTopicStats,
  type StateOf,
  type TelemetryOf,
} from "../lib/orchestrator/protocol.js";
import { report, span, type Span } from "./diagnostics.js";
import { attachStore } from "./store-hub.js";

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

export class ServerSession<C extends Contract> {
  /** Authoritative state, seeded from the contract defaults. */
  readonly state: StateOf<C>;
  // Merged telemetry snapshot (patches applied on top of contract defaults) —
  // needed so a subscriber arriving after a one-shot publish (e.g. `ready`,
  // `list`, `connected`) still sees it, instead of waiting for the next patch
  // that may never come. See docs/refactor/orchestrator.md §12.1 C3.
  private readonly telemetrySnapshot: Record<string, any>;
  private readonly channels = new Set<Channel>(); // attached (command-capable)
  private readonly subscribers = new Set<Channel>(); // interested (telemetry/frames)
  // V4 (docs/refactor/orchestrator.md §7.1): last payload per frame topic,
  // so a one-shot resource (e.g. a capture preview, published exactly once)
  // still reaches a channel that only opens its `frame(name)` ref *after*
  // the publish — otherwise it's silently dropped (no listener yet
  // client-side, and under C10 the server wouldn't even attempt the send).
  // Bounded by clearing on idle/dispose, not by topic count — dynamic
  // per-capture channel names would otherwise accumulate forever.
  private readonly frameCache = new Map<string, FramePayload>();
  // S5 (docs/refactor/orchestrator.md §7.1): timestamp of the most recent
  // activation (subscribers 0 -> 1), cleared once the first frame after it
  // publishes — measures "activate -> first frame" ("time to live stream")
  // generically for every session, without per-module instrumentation.
  private activatedAt: number | null = null;
  private readonly commands = new Map<string, (arg: any) => any>();
  private readonly stateWatchers = new Set<(key: string, value: any) => void>();
  private activateFn?: () => void;
  private idleFn?: () => void;

  constructor(
    readonly name: string,
    contract: C,
  ) {
    this.state = { ...contract.state } as StateOf<C>;
    this.telemetrySnapshot = { ...contract.telemetry };
  }

  /** Register a command handler (called when a client invokes it). */
  command<K extends keyof CommandsOf<C>>(
    name: K,
    handler: (arg: CommandsOf<C>[K]["arg"]) => CommandsOf<C>[K]["ret"] | Promise<CommandsOf<C>[K]["ret"]>,
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

  /** Called when the last renderer unsubscribes (release session resources). */
  onIdle(fn: () => void): this {
    this.idleFn = fn;
    return this;
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

  /** Report a session-scoped failure — logged locally and forwarded to every
   *  renderer connected to this session, so it's visible without watching the
   *  orchestrator console. See §12.1 C7. */
  error(message: string): void {
    report(this.name, message);
  }

  // `string & {}` allows dynamic channels (e.g. one per camera serial) while
  // keeping autocomplete for the contract's static frame names.
  //
  // C10 (docs/refactor/orchestrator.md §7.1 item 3): only send to
  // subscribers that declared interest in *this* topic — a session
  // subscriber that never opened `frame(name)` for it shouldn't pay the
  // structured-clone + backpressure-gate cost for a topic it never reads.
  frame(name: FrameOf<C> | (string & {}), payload: FramePayload): void {
    const t = topic.frame(this.name, String(name));
    this.frameCache.set(t, payload); // V4: last-payload cache, replayed on late interest
    if (this.activatedAt !== null) {
      span(`session.${this.name}.timeToFirstFrame`, performance.now() - this.activatedAt);
      this.activatedAt = null;
    }
    for (const ch of this.subscribers) if (ch.hasFrameInterest(t)) ch.sendFrame(t, payload);
  }

  /** Wire one client connection to this session (commands + state writes). */
  attach(ch: Channel): void {
    this.channels.add(ch);
    for (const [cname, fn] of this.commands)
      ch.handle(topic.command(this.name, cname), fn);
    // V4: replay a cached last-payload to a channel that declares interest
    // in a frame topic *after* it was already published — see `frame()`.
    // Every session attached to `ch` gets this callback; a lookup miss for a
    // topic another session owns is just a harmless no-op.
    ch.onFrameInterest((t) => {
      const cached = this.frameCache.get(t);
      if (cached) ch.sendFrame(t, cached);
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
      // stale value. See §12.1 C8.
      for (const peer of this.subscribers)
        if (peer !== ch) peer.emit(topic.state(this.name), { key, value });
    });
  }

  detach(ch: Channel): void {
    this.channels.delete(ch);
    this.unsubscribe(ch);
  }

  /** A renderer began viewing this session: seed it + (re)start resources. */
  subscribe(ch: Channel): void {
    if (this.subscribers.has(ch)) return;
    this.subscribers.add(ch);
    // Seed the new subscriber with the current state + telemetry snapshot —
    // without the telemetry seed, one-shot keys (`ready`, `list`, `connected`)
    // published before this subscriber arrived would never reach it (C3).
    for (const key of Object.keys(this.state))
      ch.emit(topic.state(this.name), { key, value: (this.state as any)[key] });
    ch.emit(topic.telemetry(this.name), this.telemetrySnapshot);
    if (this.subscribers.size === 1) {
      this.activatedAt = performance.now();
      this.activateFn?.();
    }
  }

  /** A renderer stopped viewing; release resources when nobody is left. */
  unsubscribe(ch: Channel): void {
    if (!this.subscribers.delete(ch)) return;
    if (this.subscribers.size === 0) {
      this.idleFn?.();
      this.frameCache.clear(); // V4: bound memory — stale previews from this activation are gone anyway
    }
  }

  /**
   * Force-release session resources regardless of current subscriber count —
   * used both for orchestrator shutdown and for handing exclusive hardware
   * access back to a non-migrated renderer module (§12.3 R4). Clearing
   * `subscribers` (not just calling `idleFn`) matters: without it, a later
   * genuine subscribe from a still-mounted client wouldn't re-fire
   * `activateFn` (the count would never have returned to zero).
   */
  dispose(): void {
    this.subscribers.clear();
    this.idleFn?.();
    this.frameCache.clear();
  }
}

/**
 * Declarative session shape checked against the contract: `commands` must
 * implement every command the contract declares (missing/mistyped = compile
 * error — no more stringly-dispatched `session.command("name", fn)` calls),
 * and `watch` is typed per state key instead of a manually-`switch`ed
 * `(key, value)` callback. `build` receives the already-constructed
 * `ServerSession` so handlers can close over `s.state`/`s.telemetry`/`s.frame`/
 * `s.error` — the same object `defineSession` returns. See
 * docs/refactor/orchestrator.md §12.3 R2.
 */
export interface SessionDefinition<C extends Contract> {
  /** First renderer subscribed — (re)start session-owned resources. */
  activate?(): void;
  /** Last renderer unsubscribed — release session-owned resources. */
  idle?(): void;
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
  return session;
}

/** Owns every session and attaches them to each incoming client port. */
export class Hub {
  private readonly sessions: ServerSession<any>[] = [];
  private readonly byName = new Map<string, ServerSession<any>>();
  private readonly channels = new Set<Channel>();

  add<C extends Contract>(session: ServerSession<C>): ServerSession<C> {
    this.sessions.push(session);
    this.byName.set(session.name, session);
    return session;
  }

  attach(port: MessagePortMain): void {
    port.start();
    const ch = new Channel(mainEndpoint(port));
    this.channels.add(ch);
    for (const s of this.sessions) s.attach(ch);
    const detachStore = attachStore(ch);
    // Per-session interest: route subscribe/unsubscribe to the named session.
    ch.on(topic.subscribe, (name: string) => this.byName.get(name)?.subscribe(ch));
    ch.on(topic.unsubscribe, (name: string) =>
      this.byName.get(name)?.unsubscribe(ch),
    );
    port.on("close", () => {
      for (const s of this.sessions) s.detach(ch);
      detachStore();
      this.channels.delete(ch);
      ch.close(); // rejects any pending outbound requests, clears frame gate state
    });
  }

  /** Release every session's resources (called on orchestrator shutdown). */
  shutdown(): void {
    for (const s of this.sessions) s.dispose();
  }

  /** Broadcast a diagnostic error to every connected renderer, regardless of
   *  session subscription — for failures with no single owning session (e.g.
   *  the shared camera registry). See §12.1 C7. */
  reportError(scope: string, message: string): void {
    for (const ch of this.channels) ch.emit(topic.error, { scope, message });
  }

  /** Broadcast a `Span` (§7.1 S5) to every connected renderer, live, the same
   *  way `reportError` broadcasts diagnostics — a future profiler window
   *  consumes this for a real-time timeline. */
  reportSpan(s: Span): void {
    for (const ch of this.channels) ch.emit(topic.span, s);
  }

  /** Per-topic frame stats summed across every connected channel (perf
   *  substrate, §7.3 item 4 — `system.perfSnapshot` aggregates this). */
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
