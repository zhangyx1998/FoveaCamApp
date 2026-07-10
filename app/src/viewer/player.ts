// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-file playback engine for the STANDALONE viewer (standalone-viewer-and-
// fcap ruling 1 — hosted by the viewer window's worker thread, see worker.ts).
// Owns one open `FoveaSource` and replays it with timestamp pacing: each
// message is due at `(logTime - anchor) / rate` wall-clock after playback
// started, slept-to via the injectable clock (tests inject a virtual clock,
// so pacing math is asserted deterministically — no fake timers over real
// file I/O).
//
// Frames that fall too far behind schedule (> LATE_SKIP_MS, e.g. decode or
// consumer slower than the file's rate) are skipped and accounted as
// `drop("late")` on the injected meter — pacing degrades by dropping, never
// by silently stretching time. Everything is generation-guarded:
// pause/seek/play/close bump the generation, and an in-flight loop iteration
// from a stale generation stops without touching state (the V5/V10/V13
// stale-async-completion class).
//
// The player knows nothing about windows or transports — it gets
// `publishFrame` / `emitTelemetry` / `emitPosition` hooks and a `PlayerMeter`
// (a no-op by default; the orchestrator-era WorkloadHandle satisfied the same
// structural shape), keeping it unit-testable in isolation.

import type { Mat } from "core/Vision";
import type { PlaybackDoc, StreamLiveStats } from "./protocol.js";
import type { FrameDecoder } from "./decode.js";
import type { FoveaChannel, FoveaMessage, FoveaSource } from "./source.js";
import { TELEMETRY_TOPIC } from "../../../docs/schema/fovea.js";

/** Playback accounting hooks (structurally a subset of the orchestrator's
 *  `WorkloadHandle`, which the retired viewer session used to inject). The
 *  standalone viewer has no workload registry — the default meter is a no-op;
 *  tests inject a recorder to assert ingest/emit/drop accounting. */
export interface PlayerMeter {
  ingest(input: string): void;
  emit(output: string): void;
  drop(cause: string): void;
  /** Wrap the synchronous decode+publish of one frame (utilization timing). */
  measure(fn: () => void): void;
  dispose(): void;
}

export const nullMeter: PlayerMeter = {
  ingest: () => {},
  emit: () => {},
  drop: () => {},
  measure: (fn) => fn(),
  dispose: () => {},
};

export interface PlayerClock {
  /** Monotonic milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultClock: PlayerClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A frame later than this behind its due time is skipped (drop("late")),
 *  not published — the pacing contract degrades by dropping. */
const LATE_SKIP_MS = 200;

/** Playback position/`playing` are pushed through `emitPosition` at most this
 *  often mid-playback (plus immediately on play/pause/seek/end). */
const POSITION_UPDATE_MS = 250;

/** Sliding window for the live decode-rate stat (stats popover): decode
 *  timestamps older than this are dropped before the rate is computed. */
const RATE_WINDOW_MS = 2000;
const telemetryDecoder = new TextDecoder();

export interface PlayerHooks {
  /** Publish one decoded display frame for a channel topic. */
  publishFrame(topic: string, mat: Mat<Uint8Array>, convertMs: number): void;
  /** Latest replayed telemetry-channel document (parsed JSON). */
  emitTelemetry?: (doc: PlaybackDoc) => void;
  /** Latest replayed DESCRIPTOR document for a non-telemetry json channel
   *  (multi-fovea `fovea/<target>` tracks — bbox overlay data, ruling 6).
   *  Keyed by channel topic; latest-wins at playback rate (the nearest-sample
   *  the overlay draws). Absent → descriptor tracks are ingested + dropped. */
  emitDescriptor?: (topic: string, doc: PlaybackDoc) => void;
  /** Position/playing changed (throttled during playback). */
  emitPosition(positionNs: number, playing: boolean): void;
}

export interface Player {
  readonly positionNs: number;
  readonly playing: boolean;
  play(rate: number): void;
  pause(): void;
  /** Jump to `tNs` (relative). Paused: republish latest-before frames so a
   *  scrub redraws. Playing: resume from there. */
  seek(tNs: number): Promise<void>;
  /** Restrict which FRAME channels are decoded (viewer-timeline ruling 3): a
   *  channel absent from the set is ingested + dropped without decode. `null`
   *  = decode all frame channels (the default). Newly-enabled channels get a
   *  seek-refresh at the current position while paused so they repaint. */
  setEnabled(channels: readonly string[] | null): void;
  /** LIVE per-channel stats for the right-click stats popover: frames decoded,
   *  recent decode rate, and the log-time of the frame currently shown for the
   *  channel. A never-decoded channel reports zeros / null. */
  liveStats(topic: string): StreamLiveStats;
  close(): Promise<void>;
}

export function createPlayer(
  source: FoveaSource,
  decoderFor: (channel: FoveaChannel) => Promise<FrameDecoder>,
  workload: PlayerMeter,
  hooks: PlayerHooks,
  clock: PlayerClock = defaultClock,
): Player {
  const durationNs = Number(source.endNs - source.startNs);
  const channelById = new Map(source.channels.map((c) => [c.id, c]));
  // Frame channels = everything except json-encoded (telemetry/descriptor)
  // tracks; descriptor topics = json tracks other than `telemetry` (their
  // latest-before doc is republished on a paused scrub like frames are).
  const frameTopics = source.channels
    .filter((c) => c.messageEncoding !== "json")
    .map((c) => c.topic);
  const descriptorTopics = source.channels
    .filter((c) => c.messageEncoding === "json" && c.topic !== TELEMETRY_TOPIC)
    .map((c) => c.topic);

  const decoders = new Map<number, Promise<FrameDecoder | null>>();
  function decoder(channel: FoveaChannel): Promise<FrameDecoder | null> {
    let d = decoders.get(channel.id);
    if (!d) {
      // A channel that can't build a decoder (foreign dtype) is skipped —
      // and accounted — for the rest of this file's lifetime, never fatal.
      d = decoderFor(channel).catch(() => null);
      decoders.set(channel.id, d);
    }
    return d;
  }

  let positionNs = 0; // relative, 0..durationNs
  let playing = false;
  let rate = 1; // last requested playback rate — reused by seek-while-playing
  let generation = 0;
  let closed = false;
  let lastUpdateAt = -Infinity;
  // Enabled frame-channel gate (ruling 3): null = decode every frame channel;
  // a Set restricts decode to those topics (others ingest + drop). json
  // (telemetry/descriptor) channels are never gated — they're cheap and feed
  // overlays regardless of which tiles are shown.
  let enabled: Set<string> | null = null;
  const frameTopicSet = new Set(frameTopics);
  // Live per-channel decode stats for the stats popover (out-of-band from the
  // coarse PlayerMeter accounting): frames decoded, a sliding window of recent
  // decode wall-times (→ rate), and the log-time of the frame last shown.
  const live = new Map<string, { decoded: number; lastFrameNs: number | null; recent: number[] }>();
  function noteDecode(topic: string, relNs: number): void {
    let s = live.get(topic);
    if (!s) {
      s = { decoded: 0, lastFrameNs: null, recent: [] };
      live.set(topic, s);
    }
    s.decoded++;
    s.lastFrameNs = relNs;
    const now = clock.now();
    s.recent.push(now);
    while (s.recent.length > 0 && now - s.recent[0]! > RATE_WINDOW_MS) s.recent.shift();
  }

  function startLoop(myGeneration: number): void {
    void runLoop(myGeneration, rate).catch((e) => {
      workload.drop("error");
      console.error("[viewer] playback loop failed:", e);
    });
  }

  function pushUpdate(force: boolean): void {
    const t = clock.now();
    if (!force && t - lastUpdateAt < POSITION_UPDATE_MS) return;
    lastUpdateAt = t;
    hooks.emitPosition(positionNs, playing);
  }

  async function handleMessage(msg: FoveaMessage, lateMs: number): Promise<void> {
    const channel = channelById.get(msg.channelId);
    if (!channel) return;
    workload.ingest(channel.topic);
    if (channel.messageEncoding === "json") {
      try {
        const doc = JSON.parse(telemetryDecoder.decode(msg.data)) as PlaybackDoc;
        if (channel.topic === TELEMETRY_TOPIC) {
          const emitTelemetry = hooks.emitTelemetry;
          if (!emitTelemetry) throw new Error("viewer player missing telemetry hook");
          emitTelemetry(doc);
        } else {
          // Descriptor track (`fovea/<target>` — ruling 6): latest-wins per
          // topic; no hook → ingest-and-drop (still accounted above).
          hooks.emitDescriptor?.(channel.topic, doc);
        }
        workload.emit("telemetry");
      } catch {
        workload.drop("undecodable");
      }
      return;
    }
    // Enabled-set gate (ruling 3): a frame channel that isn't currently
    // displayed is ingested + dropped BEFORE the (expensive) decode.
    if (enabled && !enabled.has(channel.topic)) {
      workload.drop("disabled");
      return;
    }
    if (lateMs > LATE_SKIP_MS) {
      workload.drop("late");
      return;
    }
    const decode = await decoder(channel);
    if (!decode) {
      workload.drop("undecodable");
      return;
    }
    workload.measure(() => {
      const t0 = clock.now();
      const mat = decode(msg.data);
      hooks.publishFrame(channel.topic, mat, clock.now() - t0);
    });
    noteDecode(channel.topic, Number(msg.logTime - source.startNs));
    workload.emit("frames");
  }

  async function runLoop(myGeneration: number, rate: number): Promise<void> {
    const anchorNs = positionNs;
    const anchorMs = clock.now();
    try {
      for await (const msg of source.messages({
        startNs: source.startNs + BigInt(Math.round(positionNs)),
      })) {
        if (myGeneration !== generation) return;
        const relNs = Number(msg.logTime - source.startNs);
        const dueMs = (relNs - anchorNs) / 1e6 / rate;
        const wait = dueMs - (clock.now() - anchorMs);
        if (wait > 1) await clock.sleep(wait);
        if (myGeneration !== generation) return;
        await handleMessage(msg, Math.max(0, -wait));
        if (myGeneration !== generation) return;
        positionNs = relNs;
        pushUpdate(false);
      }
      // End of file: land on the end, stop.
      if (myGeneration !== generation) return;
      positionNs = durationNs;
      playing = false;
      pushUpdate(true);
    } catch (e) {
      if (myGeneration !== generation) return;
      playing = false;
      pushUpdate(true);
      throw e;
    }
  }

  /** Paused-scrub redraw: latest frame at-or-before the position, per frame
   *  channel (channels with nothing before the position stay as they were) +
   *  the latest descriptor doc per descriptor track (nearest-sample overlay).
   *  A channel with nothing at-or-before the position (mid-file appearance,
   *  seek before its first message) is simply absent — no frame, not a crash. */
  async function republishAt(tNs: number): Promise<void> {
    const topics = [...frameTopics, ...descriptorTopics];
    if (topics.length === 0) return;
    const at = source.startNs + BigInt(Math.round(tNs));
    const latest = await source.latestBefore(at, topics);
    for (const msg of latest.values()) await handleMessage(msg, 0);
  }

  /** Republish the latest-before frame for a specific set of frame topics at
   *  the current position — the seek-refresh a channel gets when it is newly
   *  enabled while paused (ruling 3), so it repaints without a full re-seek. */
  async function refreshTopics(topics: readonly string[]): Promise<void> {
    const wanted = topics.filter((t) => frameTopicSet.has(t));
    if (wanted.length === 0) return;
    const myGeneration = generation;
    const at = source.startNs + BigInt(Math.round(positionNs));
    const latest = await source.latestBefore(at, wanted);
    if (myGeneration !== generation) return;
    for (const msg of latest.values()) await handleMessage(msg, 0);
  }

  return {
    get positionNs() {
      return positionNs;
    },
    get playing() {
      return playing;
    },

    play(newRate: number): void {
      if (closed) return;
      if (!(newRate > 0)) throw new Error(`invalid playback rate ${newRate}`);
      rate = newRate;
      const myGeneration = ++generation; // re-pace: replaces any running loop
      if (positionNs >= durationNs) positionNs = 0; // replay from the top
      playing = true;
      pushUpdate(true);
      startLoop(myGeneration);
    },

    pause(): void {
      if (closed) return;
      generation++;
      if (!playing) return;
      playing = false;
      pushUpdate(true);
    },

    async seek(tNs: number): Promise<void> {
      if (closed) return;
      const wasPlaying = playing;
      const myGeneration = ++generation; // stops any in-flight loop
      positionNs = Math.min(Math.max(0, tNs), durationNs);
      pushUpdate(true);
      if (wasPlaying) {
        // Playing: resume from the new position at the current rate.
        startLoop(myGeneration);
        return;
      }
      await republishAt(positionNs);
      if (myGeneration !== generation) return;
      pushUpdate(true);
    },

    setEnabled(channels: readonly string[] | null): void {
      if (closed) return;
      const prev = enabled;
      enabled = channels ? new Set(channels) : null;
      // Newly-enabled frame channels get a paused seek-refresh so they repaint
      // at the playhead immediately (during playback their frames stream in on
      // their own). Skip while playing — the running loop already feeds them.
      if (playing) return;
      const added = [...(enabled ?? frameTopicSet)].filter(
        (t) => frameTopicSet.has(t) && !(prev ? prev.has(t) : true),
      );
      if (added.length === 0) return;
      void refreshTopics(added).catch((error) => {
        workload.drop("error");
        console.error("[viewer] enable-refresh failed:", error);
      });
    },

    liveStats(topic: string): StreamLiveStats {
      const s = live.get(topic);
      if (!s) return { decoded: 0, rateHz: 0, lastFrameNs: null };
      // Rate over the retained window: (n-1) intervals across their wall-span.
      const now = clock.now();
      const recent = s.recent.filter((t) => now - t <= RATE_WINDOW_MS);
      const spanMs = recent.length >= 2 ? recent[recent.length - 1]! - recent[0]! : 0;
      const rateHz = spanMs > 0 ? ((recent.length - 1) / spanMs) * 1000 : 0;
      return { decoded: s.decoded, rateHz, lastFrameNs: s.lastFrameNs };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      generation++;
      playing = false;
      await source.close();
      workload.dispose();
    },
  };
}
