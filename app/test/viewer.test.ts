// STANDALONE viewer playback (standalone-viewer-and-fcap ruling 1; formerly
// the C-8 `viewer` session, retired) — the container playback data layer,
// tested end to end against a REAL synthetic container generated in-test by
// the B-5 recorder sink. The PLAYER (src/viewer/player.ts — the exact engine
// the viewer window's worker hosts) is driven directly through its hooks;
// decode is injected (no core native in vitest, per house convention); the
// clock is virtual, so pacing math is asserted deterministically instead of
// racing real timers. One-window-per-file dedupe is a WINDOW concern now and
// is covered by window-manager.test.ts.

import { mkdtemp, open, readFile, rm, stat, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mat } from "core/Vision";
import { createFoveaSink, FOVEA_EXTENSION } from "@orchestrator/recorder";
import {
  createPlayer,
  type Player,
  type PlayerClock,
  type PlayerMeter,
} from "@src/viewer/player";
import { openFovea } from "@src/viewer/source";
import type { PlaybackDoc } from "@src/viewer/protocol";

const tmpRoots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "foveacam-viewer-"));
  tmpRoots.push(dir);
  return dir;
}

function frame16(values: number[]): Mat {
  return Object.assign(new Uint16Array(values), { shape: [2, 2], channels: 1 }) as never;
}

/** 6 frames on `cam` at t = 0.1s..0.6s (100 ms apart), extras (→ telemetry
 *  docs) on the first two, plus one frame on a second channel `aux`. */
async function writeFixture(dir: string): Promise<string> {
  const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
    writer: { chunkBytes: 1 },
  });
  for (let i = 0; i < 6; i++) {
    const extras = i < 2 ? { volt: { p: i, t: -i } } : {};
    sink.write("cam", frame16([i, i + 1, i + 2, i + 3]), "Mono12p", 0.1 * (i + 1), extras);
  }
  sink.write("aux", frame16([9, 9, 9, 9]), "Mono16", 0.35);
  await sink.finalize(0.6);
  return join(dir, `recording${FOVEA_EXTENSION}`);
}

/** Virtual clock: sleep() records the request and advances time instantly —
 *  the recorded schedule IS the pacing assertion. */
function virtualClock(): PlayerClock & { sleeps: number[]; t: number } {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

/** Fake decoder: tags each decode with the raw bytes so tests can assert
 *  which message landed, without core Vision. */
const fakeDecoderFor = async () => (bytes: Uint8Array) =>
  Object.assign(new Uint8Array(bytes), { shape: [2, 2], channels: 1 }) as Mat<Uint8Array>;

/** Recording meter (the standalone player takes a `PlayerMeter`, no-op in
 *  production — tests inject this recorder to assert accounting). */
function recordingMeter(): PlayerMeter & {
  ingests: string[];
  emits: string[];
  drops: string[];
  disposed: boolean;
} {
  const meter = {
    ingests: [] as string[],
    emits: [] as string[],
    drops: [] as string[],
    disposed: false,
    ingest: (input: string) => void meter.ingests.push(input),
    emit: (output: string) => void meter.emits.push(output),
    drop: (cause: string) => void meter.drops.push(cause),
    measure: (fn: () => void) => fn(),
    dispose: () => {
      meter.disposed = true;
    },
  };
  return meter;
}

interface Harness {
  player: Player;
  clock: ReturnType<typeof virtualClock>;
  meter: ReturnType<typeof recordingMeter>;
  frames: Array<{ topic: string; bytes: Uint8Array }>;
  telemetry: PlaybackDoc[];
  positions: Array<{ positionNs: number; playing: boolean }>;
  durationNs: number;
  truncated: boolean;
  close(): Promise<void>;
}

/** Open a real container and drive the player exactly like the worker does —
 *  hooks captured locally instead of posted to a window. */
async function harness(file: string): Promise<Harness> {
  const source = await openFovea(file);
  const clock = virtualClock();
  const meter = recordingMeter();
  const frames: Harness["frames"] = [];
  const telemetry: PlaybackDoc[] = [];
  const positions: Harness["positions"] = [];
  const player = createPlayer(
    source,
    fakeDecoderFor,
    meter,
    {
      publishFrame: (topic, mat) =>
        void frames.push({ topic, bytes: new Uint8Array(mat) }),
      emitTelemetry: (doc) => void telemetry.push(doc),
      emitPosition: (positionNs, playing) => void positions.push({ positionNs, playing }),
    },
    clock,
  );
  return {
    player,
    clock,
    meter,
    frames,
    telemetry,
    positions,
    durationNs: Number(source.endNs - source.startNs),
    truncated: source.truncated,
    close: () => player.close(),
  };
}

/** Wait (real time, bounded) until `cond` holds — playback loops hop across
 *  real async file reads even under the virtual clock. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const NS = 1e9;

describe("standalone viewer player (over a real container)", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("exposes channels/duration through the source and does not autoplay", async () => {
    const file = await writeFixture(await tempRoot());
    const source = await openFovea(file);
    expect(source.truncated).toBe(false);
    // t = 0.1..0.6 s → 0.5 s span
    expect(Number(source.endNs - source.startNs)).toBe(0.5 * NS);
    const names = source.channels.map((c) => c.topic).sort();
    expect(names).toEqual(["aux", "cam", "telemetry"]);
    const cam = source.channels.find((c) => c.topic === "cam")!;
    expect(cam.metadata).toMatchObject({
      dtype: "U16",
      pixelFormat: "Mono12p",
      significantBits: "12",
      messageEncoding: "x-fovea-raw",
    });
    expect(
      source.channels.find((c) => c.topic === "telemetry")!.metadata.messageEncoding,
    ).toBe("json");

    const h = await harness(file);
    expect(h.player.playing).toBe(false);
    expect(h.player.positionNs).toBe(0);
    expect(h.frames).toHaveLength(0); // opening never publishes
    await h.close();
    await source.close();
  });

  it("plays timestamp-paced through the hooks, then stops at the end", async () => {
    const file = await writeFixture(await tempRoot());
    const h = await harness(file);

    h.player.play(1);
    await until(() => !h.player.playing && h.player.positionNs === 0.5 * NS);

    // Every cam frame decoded + published; aux too.
    const camFrames = h.frames.filter((f) => f.topic === "cam");
    expect(camFrames).toHaveLength(6);
    // Decoded payload carries the message bytes (fake decoder passthrough):
    // first cam frame was Uint16 [0,1,2,3].
    expect(Array.from(new Uint16Array(camFrames[0]!.bytes.slice().buffer))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(h.frames.some((f) => f.topic === "aux")).toBe(true);

    // Pacing: messages sit 100 ms apart (aux at 0.35 s splits one gap into
    // 50+50) — the virtual clock recorded (nearly) the whole 500 ms span.
    const slept = h.clock.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeGreaterThan(450);
    expect(slept).toBeLessThanOrEqual(510);

    // telemetry docs (2 extras) replayed onto the telemetry hook
    expect(h.telemetry).toHaveLength(2);
    expect(h.telemetry[1]).toMatchObject({ stream: "cam", seq: 1 });

    // ended: position landed on the duration, playing false
    expect(h.positions.at(-1)).toEqual({ positionNs: 0.5 * NS, playing: false });

    // meter counted ingest + emits
    expect(h.meter.ingests.filter((i) => i === "cam")).toHaveLength(6);
    expect(h.meter.emits.filter((e) => e === "frames")).toHaveLength(7);
    expect(h.meter.emits.filter((e) => e === "telemetry")).toHaveLength(2);
    await h.close();
    expect(h.meter.disposed).toBe(true);
  });

  it("rate scales the pacing schedule", async () => {
    const file = await writeFixture(await tempRoot());
    const h = await harness(file);
    h.player.play(2);
    await until(() => !h.player.playing && h.player.positionNs === 0.5 * NS);
    const slept = h.clock.sleeps.reduce((a, b) => a + b, 0);
    // 500 ms of media at 2× ≈ 250 ms wall
    expect(slept).toBeGreaterThan(220);
    expect(slept).toBeLessThanOrEqual(260);
    await h.close();
  });

  it("seek while paused republishes the latest frame at-or-before the target", async () => {
    const file = await writeFixture(await tempRoot());
    const h = await harness(file);

    // tNs is RELATIVE to the first message (0.1 s absolute): 0.25 s relative
    // = 0.35 s absolute → cam's latest ≤ target is frame #2 (t=0.3 s abs,
    // bytes [2,3,4,5]); aux's is its only frame (exactly 0.35 s abs).
    await h.player.seek(0.25 * NS);
    const camFrames = h.frames.filter((f) => f.topic === "cam");
    expect(camFrames).toHaveLength(1);
    expect(Array.from(new Uint16Array(camFrames[0]!.bytes.slice().buffer))).toEqual([
      2, 3, 4, 5,
    ]);
    expect(h.frames.some((f) => f.topic === "aux")).toBe(true);
    expect(h.player.positionNs).toBe(0.25 * NS);
    expect(h.player.playing).toBe(false);
    await h.close();
  });

  it("footerless (crash-truncated) file: streaming fallback recovers, flags truncated", async () => {
    const dir = await tempRoot();
    // Dedicated fixture with KB-scale frames so message chunks dominate the
    // byte layout — a 60% cut then provably lands mid-message-stream (the
    // tiny shared fixture is mostly header/summary, and a prefix of it keeps
    // every message).
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
      writer: { chunkBytes: 1 },
    });
    for (let i = 0; i < 6; i++) {
      const big = Object.assign(new Uint16Array(1024).fill(i), {
        shape: [32, 32],
        channels: 1,
      }) as never;
      sink.write("cam", big, "Mono12p", 0.1 * (i + 1), {});
    }
    await sink.finalize(0.6);
    const file = join(dir, `recording${FOVEA_EXTENSION}`);
    const { size } = await stat(file);
    await truncate(file, Math.floor(size * 0.6));

    const h = await harness(file);
    expect(h.truncated).toBe(true);
    expect(h.durationNs).toBeGreaterThan(0);

    h.player.play(1);
    await until(() => !h.player.playing && h.player.positionNs >= h.durationNs);
    const camFrames = h.frames.filter((f) => f.topic === "cam");
    expect(camFrames.length).toBeGreaterThan(0); // recovered flushed frames
    expect(camFrames.length).toBeLessThan(6); // but not the truncated tail
    await h.close();
  });

  it("close() stops playback and disposes the meter (window teardown path)", async () => {
    const file = await writeFixture(await tempRoot());
    const h = await harness(file);
    h.player.play(1);
    await h.close();
    expect(h.player.playing).toBe(false);
    expect(h.meter.disposed).toBe(true);
    // Post-close commands are inert, never throw (the worker relays blindly).
    h.player.play(1);
    h.player.pause();
    await h.player.seek(0);
    expect(h.player.playing).toBe(false);
  });
});

describe("openFovea source layer", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("indexed path: time-range queries and latestBefore work off the index", async () => {
    const dir = await tempRoot();
    const file = await writeFixture(dir);
    const source = await openFovea(file);
    expect(source.truncated).toBe(false);
    expect(source.startNs).toBe(100_000_000n);
    expect(source.endNs).toBe(600_000_000n);

    // Range query: frames in [0.3s, 0.45s] = cam@0.3, aux@0.35, cam@0.4.
    const got: bigint[] = [];
    for await (const m of source.messages({
      startNs: 300_000_000n,
      endNs: 450_000_000n,
      topics: ["cam", "aux"],
    }))
      got.push(m.logTime);
    expect(got).toEqual([300_000_000n, 350_000_000n, 400_000_000n]);

    const latest = await source.latestBefore(450_000_000n, ["cam", "aux"]);
    expect(latest.get("cam")?.logTime).toBe(400_000_000n);
    expect(latest.get("aux")?.logTime).toBe(350_000_000n);
    await source.close();
  });

  it("streaming fallback yields recovered messages — never buffer-then-throw (B's pitfall)", async () => {
    // The Python mcap reader's log_time_order=true sorts by consuming the
    // ENTIRE stream first, so a footerless file throws before yielding ONE
    // message. Pin that our fallback streams raw records instead: iterating
    // a truncated container must complete without throwing and yield every
    // message that was flushed before the cut (0 < n < total).
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
      writer: { chunkBytes: 1 },
    });
    for (let i = 0; i < 6; i++) {
      const big = Object.assign(new Uint16Array(1024).fill(i), {
        shape: [32, 32],
        channels: 1,
      }) as never;
      sink.write("cam", big, "Mono12p", 0.1 * (i + 1), {});
    }
    await sink.finalize(0.6);
    const file = join(dir, `recording${FOVEA_EXTENSION}`);
    await truncate(file, Math.floor((await stat(file)).size * 0.6));

    const source = await openFovea(file);
    expect(source.truncated).toBe(true);
    const recovered: bigint[] = [];
    for await (const m of source.messages({ topics: ["cam"] })) recovered.push(m.logTime);
    expect(recovered.length).toBeGreaterThan(0); // yielded what was flushed…
    expect(recovered.length).toBeLessThan(6); // …up to (not past) the cut
    // and in file order = log-time order for a single-channel writer
    expect([...recovered].sort((a, b) => Number(a - b))).toEqual(recovered);
    await source.close();
  });

  it("streaming fallback yields progressively — first message needs far fewer reads than a full scan (C-P7 bounded memory)", async () => {
    const dir = await tempRoot();
    const sink = await createFoveaSink(dir, "2026-07-06T00:00:00.000Z", {
      writer: { chunkBytes: 1 },
    });
    // ~2.4 MB of frame bytes so the recovered body spans several 512 KB read
    // chunks — then "first message" provably reads less of the file than "all".
    const FRAMES = 60;
    for (let i = 0; i < FRAMES; i++) {
      const big = Object.assign(new Uint16Array(20000).fill(i), {
        shape: [200, 100],
        channels: 1,
      }) as never;
      sink.write("cam", big, "Mono16", 0.01 * (i + 1), {});
    }
    await sink.finalize(1.0);
    const file = join(dir, `recording${FOVEA_EXTENSION}`);
    // Trim just the tail → streaming fallback, but keep most of the body.
    await truncate(file, Math.floor((await stat(file)).size * 0.9));

    const source = await openFovea(file);
    expect(source.truncated).toBe(true);

    // Count FileHandle.read calls via the shared prototype (spyOn calls
    // through, so reads still work).
    const probe = await open(file, "r");
    const proto = Object.getPrototypeOf(probe) as { read: (...a: never[]) => unknown };
    await probe.close();
    const spy = vi.spyOn(proto, "read");

    // Full drain reads the whole recovered body — multiple 512 KB chunks.
    spy.mockClear();
    let total = 0;
    for await (const _m of source.messages({ topics: ["cam"] })) total++;
    const fullReads = spy.mock.calls.length;
    expect(total).toBeGreaterThan(1);
    expect(fullReads).toBeGreaterThan(1);

    // Pulling ONLY the first message must not read the whole file — the old
    // collect-then-yield needed a full scan even for one message.
    spy.mockClear();
    const iter = source.messages({ topics: ["cam"] });
    const first = await iter.next();
    const firstReads = spy.mock.calls.length;
    await iter.return?.(); // stop early, unwind the scan
    expect(first.done).toBe(false);
    expect(firstReads).toBeLessThan(fullReads);

    spy.mockRestore();
    await source.close();
  });

  it("rejects a non-MCAP file cleanly (no zombie handle, clear error)", async () => {
    const dir = await tempRoot();
    const bogus = join(dir, "not-a-container.fcap");
    await writeFile(bogus, "definitely not mcap");
    // Falls through to the streaming fallback, which recovers nothing:
    const source = await openFovea(bogus);
    expect(source.truncated).toBe(true);
    expect(source.channels).toHaveLength(0);
    expect(Number(source.endNs - source.startNs)).toBe(0);
    await source.close();
    expect(await readFile(bogus, "utf8")).toBe("definitely not mcap"); // untouched
  });
});
