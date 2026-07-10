// Paused-scrub seek COALESCING for the standalone viewer player
// (src/viewer/player.ts). A playhead drag fires one `seek` per pointermove, and
// each paused seek does a full `latestBefore` + multi-topic decode. Without
// coalescing those queue up FIFO and the UI trails the whole backlog (the
// user-reported drag lag). The fix is LATEST-WINS: while one refresh is in
// flight, newer scrub targets supersede it — only the newest is decoded, and an
// in-flight pass is dropped the moment a newer target lands.
//
// These tests drive `createPlayer` directly with a fully controllable fake
// source whose `latestBefore` can BLOCK, so a flood of seeks provably piles up
// during one refresh and we can assert both fewer decode passes AND that the
// LAST seek wins.

import { describe, expect, it } from "vitest";
import type { Mat } from "core/Vision";
import { createPlayer, nullMeter } from "@src/viewer/player";
import type { FoveaChannel, FoveaMessage, FoveaSource } from "@src/viewer/source";

/** Encode a scrub target (ns) into a frame's bytes so a passthrough decoder can
 *  round-trip it — this is how each published frame proves WHICH seek produced
 *  it. */
function encodeTarget(target: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, target);
  return bytes;
}
function decodeTarget(mat: Mat<Uint8Array>): number {
  return new DataView(mat.buffer, mat.byteOffset, mat.byteLength).getFloat64(0);
}

/** A fake FoveaSource whose `latestBefore` returns one frame per topic, each
 *  carrying the queried target (so the published frame identifies the seek).
 *  The FIRST call BLOCKS until `releaseFirstQuery()` is called; every later call
 *  resolves immediately — this lets a drag's seeks pile up during pass #1. */
function controllableSource(topics: string[]) {
  const channels: FoveaChannel[] = topics.map((topic, id) => ({
    id,
    topic,
    messageEncoding: "x-fovea-raw",
    metadata: {},
  }));
  const idByTopic = new Map(channels.map((c) => [c.topic, c.id]));
  const queryTargets: number[] = []; // ns targets passed to latestBefore, in order
  let blockNext = true;
  let releaseFirst: (() => void) | null = null;

  const source: FoveaSource = {
    channels,
    startNs: 0n, // → latestBefore's `at` equals the raw target ns
    endNs: 1_000_000_000n,
    truncated: false,
    wideCameraDeclared: false,
    // eslint-disable-next-line require-yield
    async *messages(): AsyncGenerator<FoveaMessage, void, void> {
      // Playback path unused by these paused-scrub tests.
    },
    async latestBefore(tNs, wanted): Promise<Map<string, FoveaMessage>> {
      queryTargets.push(Number(tNs));
      if (blockNext) {
        blockNext = false;
        await new Promise<void>((r) => (releaseFirst = r));
      }
      const out = new Map<string, FoveaMessage>();
      for (const topic of wanted) {
        const id = idByTopic.get(topic);
        if (id === undefined) continue;
        out.set(topic, { channelId: id, logTime: tNs, data: encodeTarget(Number(tNs)) });
      }
      return out;
    },
    async channelSpans() {
      return new Map();
    },
    async messageCounts() {
      return new Map();
    },
    async close() {},
  };

  return {
    source,
    queryTargets,
    releaseFirstQuery: () => releaseFirst?.(),
  };
}

/** Passthrough decoder that keeps the target-encoding bytes intact. */
const passthroughDecoder = async () => (bytes: Uint8Array) =>
  Object.assign(new Uint8Array(bytes), { shape: [1, 8], channels: 1 }) as Mat<Uint8Array>;

/** Let all currently-queued microtasks drain. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("paused-scrub seek coalescing (latest-wins)", () => {
  it("collapses a flood of scrub seeks to the LAST target and drops the in-flight pass", async () => {
    const { source, queryTargets, releaseFirstQuery } = controllableSource(["cam"]);
    const published: number[] = [];
    const player = createPlayer(source, passthroughDecoder, nullMeter, {
      publishFrame: (_topic, mat) => void published.push(decodeTarget(mat)),
      emitPosition: () => {},
    });

    const A = 10_000_000;
    const B = 20_000_000;
    const C = 30_000_000;
    const D = 40_000_000; // the newest — must be the ONLY one decoded

    // Seek A owns the refresh loop; its latestBefore(A) BLOCKS. The remaining
    // seeks land while that first query is in flight (a drag's pointermoves).
    const settled = player.seek(A);
    expect(queryTargets).toEqual([A]); // pass #1 already reached the (blocked) query
    player.seek(B);
    player.seek(C);
    player.seek(D);

    // Release the blocked query. republishAt(A) resumes, sees a newer target
    // pending, and drops its decode; the loop then refreshes D only.
    releaseFirstQuery();
    await settled;

    // Only TWO latestBefore passes for FOUR seeks (A, then the coalesced D) —
    // not one full pass per message.
    expect(queryTargets).toEqual([A, D]);
    expect(queryTargets.length).toBeLessThan(4);
    // The in-flight A pass was superseded → never published; D won.
    expect(published).toEqual([D]);
    expect(published).not.toContain(A);
    // Playhead position reflects the latest seek regardless.
    expect(player.positionNs).toBe(D);

    await player.close();
  });

  it("covers every channel on the winning seek (multi-track refresh)", async () => {
    const { source, queryTargets, releaseFirstQuery } = controllableSource(["cam", "aux"]);
    const published: Array<{ topic: string; target: number }> = [];
    const player = createPlayer(source, passthroughDecoder, nullMeter, {
      publishFrame: (topic, mat) => void published.push({ topic, target: decodeTarget(mat) }),
      emitPosition: () => {},
    });

    const A = 5_000_000;
    const D = 45_000_000;
    const settled = player.seek(A);
    player.seek(D);
    releaseFirstQuery();
    await settled;

    // Both channels refreshed, both at the winning target D (not A).
    expect(queryTargets).toEqual([A, D]);
    expect(published).toHaveLength(2);
    expect(published.every((p) => p.target === D)).toBe(true);
    expect(new Set(published.map((p) => p.topic))).toEqual(new Set(["cam", "aux"]));

    await player.close();
  });

  it("a lone paused seek still refreshes normally (no coalescing regression)", async () => {
    const { source, queryTargets, releaseFirstQuery } = controllableSource(["cam"]);
    const published: number[] = [];
    const player = createPlayer(source, passthroughDecoder, nullMeter, {
      publishFrame: (_topic, mat) => void published.push(decodeTarget(mat)),
      emitPosition: () => {},
    });

    const target = 12_000_000;
    const settled = player.seek(target);
    await flush(); // let the loop reach the (blocked) query
    expect(queryTargets).toEqual([target]);
    releaseFirstQuery(); // nothing superseded it → it decodes + publishes
    await settled;

    expect(published).toEqual([target]);
    expect(player.positionNs).toBe(target);
    await player.close();
  });
});
