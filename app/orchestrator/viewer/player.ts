// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-file playback engine for the viewer session (C-8). Owns one open
// `FoveaSource` and replays it with timestamp pacing: each message is due at
// `(logTime - anchor) / rate` wall-clock after playback started, slept-to via
// the injectable clock (tests inject a virtual clock, so pacing math is
// asserted deterministically — no fake timers over real file I/O).
//
// Frames that fall too far behind schedule (> LATE_SKIP_MS, e.g. decode or
// consumer slower than the file's rate) are skipped and accounted as
// `drop("late")` on the file's workload meter — pacing degrades by dropping,
// never by silently stretching time. Everything is generation-guarded:
// pause/seek/play/close bump the generation, and an in-flight loop iteration
// from a stale generation stops without touching state (the V5/V10/V13
// stale-async-completion class).
//
// The player knows nothing about sessions or transports — it gets
// `publishFrame` / `emitTelemetry` / `emitPosition` hooks and a
// `WorkloadHandle` (`viewer:<fileId>`), keeping it unit-testable in isolation.

import type { Mat } from "core/Vision";
import type { PlaybackDoc } from "@lib/orchestrator/viewer-contract";
import type { WorkloadHandle } from "../metering.js";
import type { FrameDecoder } from "./decode.js";
import type { FoveaChannel, FoveaMessage, FoveaSource } from "./source.js";

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
const telemetryDecoder = new TextDecoder();

export interface PlayerHooks {
  /** Publish one decoded display frame for a channel topic. */
  publishFrame(topic: string, mat: Mat<Uint8Array>, convertMs: number): void;
  /** Latest replayed telemetry-channel document (parsed JSON). */
  emitTelemetry?: (doc: PlaybackDoc) => void;
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
  close(): Promise<void>;
}

export function createPlayer(
  source: FoveaSource,
  decoderFor: (channel: FoveaChannel) => Promise<FrameDecoder>,
  workload: WorkloadHandle,
  hooks: PlayerHooks,
  clock: PlayerClock = defaultClock,
): Player {
  const durationNs = Number(source.endNs - source.startNs);
  const channelById = new Map(source.channels.map((c) => [c.id, c]));
  // Frame channels = everything except json-encoded (telemetry) tracks.
  const frameTopics = source.channels
    .filter((c) => c.messageEncoding !== "json")
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
        const emitTelemetry = hooks.emitTelemetry;
        if (!emitTelemetry) throw new Error("viewer player missing telemetry hook");
        emitTelemetry(JSON.parse(telemetryDecoder.decode(msg.data)));
        workload.emit("telemetry");
      } catch {
        workload.drop("undecodable");
      }
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
   *  channel (channels with nothing before the position stay as they were). */
  async function republishAt(tNs: number): Promise<void> {
    if (frameTopics.length === 0) return;
    const at = source.startNs + BigInt(Math.round(tNs));
    const latest = await source.latestBefore(at, frameTopics);
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
