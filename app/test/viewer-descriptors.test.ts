// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Player descriptor routing (multi-fovea-recording ruling 6, wave I-2): json
// channels other than `telemetry` are DESCRIPTOR tracks — routed to the
// `emitDescriptor` hook keyed by topic (never mixed into the telemetry doc),
// republished latest-before on a paused scrub, and safely absent when a seek
// lands before the track's first message (mid-file channels).

import { describe, expect, it } from "vitest";
import { createPlayer, type PlayerClock, type PlayerMeter } from "@src/viewer/player";
import type { FoveaMessage, FoveaSource } from "@src/viewer/source";

const enc = new TextEncoder();

const fakeWorkload = (): PlayerMeter => ({
  ingest: () => {},
  emit: () => {},
  drop: () => {},
  measure: (fn: () => void) => fn(),
  dispose: () => {},
});

const instantClock: PlayerClock = {
  now: () => 0,
  sleep: async () => {},
};

/** In-memory FoveaSource: one frame channel + one descriptor channel that
 *  APPEARS MID-FILE + the standard telemetry channel. */
function fakeSource(): FoveaSource {
  const messages: FoveaMessage[] = [
    { channelId: 1, logTime: 100n, data: new Uint8Array([1, 2, 3, 4]) },
    { channelId: 3, logTime: 150n, data: enc.encode(JSON.stringify({ stream: "cam", seq: 0 })) },
    { channelId: 1, logTime: 200n, data: new Uint8Array([5, 6, 7, 8]) },
    // Descriptor channel starts MID-FILE (target armed later).
    {
      channelId: 2,
      logTime: 250n,
      data: enc.encode(JSON.stringify({ tNs: 250, bbox: { x: 1, y: 2, width: 3, height: 4 }, frames: { left: null, center: 0, right: null } })),
    },
    {
      channelId: 2,
      logTime: 350n,
      data: enc.encode(JSON.stringify({ tNs: 350, bbox: { x: 9, y: 9, width: 3, height: 4 }, frames: { left: null, center: 1, right: null } })),
    },
  ];
  return {
    channels: [
      { id: 1, topic: "center", messageEncoding: "x-fovea-raw", metadata: {} },
      { id: 2, topic: "fovea/0", messageEncoding: "json", metadata: {} },
      { id: 3, topic: "telemetry", messageEncoding: "json", metadata: {} },
    ],
    startNs: 100n,
    endNs: 350n,
    truncated: false,
    wideCameraDeclared: false,
    async channelSpans() {
      return new Map([
        ["center", { startNs: 100n, endNs: 200n }],
      ]);
    },
    async *messages(opts) {
      const from = opts?.startNs ?? 0n;
      for (const m of messages) if (m.logTime >= from) yield m;
    },
    async latestBefore(tNs, topics) {
      const byTopic = new Map<string, FoveaMessage>();
      const idFor = new Map([["center", 1], ["fovea/0", 2], ["telemetry", 3]]);
      for (const t of topics) {
        const id = idFor.get(t);
        const last = messages.filter((m) => m.channelId === id && m.logTime <= tNs).pop();
        if (last) byTopic.set(t, last);
      }
      return byTopic;
    },
    close: async () => {},
  };
}

function makePlayer() {
  const descriptors: Array<{ topic: string; doc: unknown }> = [];
  const telemetry: unknown[] = [];
  const frames: string[] = [];
  const player = createPlayer(
    fakeSource(),
    async () => (bytes) =>
      Object.assign(new Uint8Array(bytes), { shape: [2, 2], channels: 1 }) as never,
    fakeWorkload(),
    {
      publishFrame: (topic) => void frames.push(topic),
      emitTelemetry: (doc) => void telemetry.push(doc),
      emitDescriptor: (topic, doc) => void descriptors.push({ topic, doc }),
      emitPosition: () => {},
    },
    instantClock,
  );
  return { player, descriptors, telemetry, frames };
}

const until = async (cond: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("viewer player descriptor routing", () => {
  it("routes non-telemetry json tracks to emitDescriptor, keyed by topic", async () => {
    const { player, descriptors, telemetry } = makePlayer();
    player.play(1);
    await until(() => !player.playing);
    expect(telemetry).toEqual([{ stream: "cam", seq: 0 }]);
    expect(descriptors.map((d) => d.topic)).toEqual(["fovea/0", "fovea/0"]);
    expect(descriptors[1]!.doc).toMatchObject({ tNs: 350 });
    await player.close();
  });

  it("paused scrub republishes the latest-before descriptor; before the track's first message = nothing", async () => {
    const { player, descriptors } = makePlayer();
    // Scrub to 200ns (relative 100): the descriptor track hasn't started yet
    // (mid-file channel) — no descriptor, no crash.
    await player.seek(100);
    expect(descriptors.length).toBe(0);
    // Scrub past the first descriptor: the latest-before doc republishes.
    await player.seek(200); // absolute 300ns — after the 250n doc
    expect(descriptors.length).toBe(1);
    expect(descriptors[0]!.doc).toMatchObject({ tNs: 250 });
    await player.close();
  });
});
