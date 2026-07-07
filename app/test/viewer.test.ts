// `viewer` session (C-8) — the .fovea playback data layer, tested end to end
// against a REAL synthetic container generated in-test by the B-5 recorder
// sink. Frames flow through the session's standard frame transport (the fake
// transport captures them); decode is injected (no core native in vitest,
// per house convention); the clock is virtual, so pacing math is asserted
// deterministically instead of racing real timers.

import { mkdtemp, readFile, rm, stat, writeFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mat } from "core/Vision";
import { Channel, topic } from "@lib/orchestrator/protocol";
import type { ViewerFile } from "@lib/orchestrator/viewer-contract";
import { createFoveaSink } from "@orchestrator/recorder";
import { viewerSession } from "@orchestrator/sessions/viewer";
import { allWorkloadSnapshots } from "@orchestrator/metering";
import type { PlayerClock } from "@orchestrator/viewer/player";
import { openFovea } from "@orchestrator/viewer/source";
import { createEndpointPair, flush } from "./fake-endpoint";
import { installFakeFrameTransport, type FakeFrameTransport } from "./fake-frame-transport";

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
  return join(dir, "recording.fovea");
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

interface Harness {
  call<T = unknown>(command: string, arg?: unknown): Promise<T>;
  files(): Record<string, ViewerFile>;
  playbackDocs(): Record<string, Record<string, unknown> | null>;
  transports: FakeFrameTransport[];
  clock: ReturnType<typeof virtualClock>;
  /** Force-idle the session and await the file-close drain — keeps meters
   *  from one test leaking into the next (fileIds restart at f1). */
  dispose(): Promise<void>;
}

function harness(): Harness {
  const transports = installFakeFrameTransport();
  const clock = virtualClock();
  const session = viewerSession({ decoderFor: fakeDecoderFor, clock });
  const [serverEp, clientEp] = createEndpointPair();
  const server = new Channel(serverEp);
  const client = new Channel(clientEp);
  session.attach(server);
  session.subscribe(server);

  let files: Record<string, ViewerFile> = {};
  let docs: Record<string, Record<string, unknown> | null> = {};
  client.on(topic.state("viewer"), (patch: { key: string; value: never }) => {
    if (patch.key === "files") files = patch.value;
  });
  client.on(topic.telemetry("viewer"), (patch: { playback?: never }) => {
    if (patch.playback) docs = patch.playback;
  });

  return {
    call: (command, arg) => client.request(topic.command("viewer", command), arg),
    files: () => files,
    playbackDocs: () => docs,
    transports,
    clock,
    dispose: () => {
      session.dispose();
      return session.drained();
    },
  };
}

/** Wait (real time, bounded) until `cond` holds — playback loops hop across
 *  real async file reads even under the virtual clock. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
    await flush();
  }
}

const NS = 1e9;

describe("viewer session (C-8)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("open() exposes channels/metadata/duration in state and does not autoplay", async () => {
    const h = harness();
    const file = await writeFixture(await tempRoot());
    const { fileId } = await h.call<{ fileId: string }>("open", file);
    await flush();

    const f = h.files()[fileId];
    expect(f).toBeDefined();
    expect(f.path).toBe(file);
    expect(f.playing).toBe(false);
    expect(f.positionNs).toBe(0);
    expect(f.truncated).toBe(false);
    // t = 0.1..0.6 s → 0.5 s span
    expect(f.durationNs).toBe(0.5 * NS);
    const names = f.channels.map((c) => c.name).sort();
    expect(names).toEqual(["aux", "cam", "telemetry"]);
    const cam = f.channels.find((c) => c.name === "cam")!;
    expect(cam.metadata).toMatchObject({
      dtype: "U16",
      pixelFormat: "Mono12p",
      significantBits: "12",
      messageEncoding: "x-fovea-raw",
    });
    expect(f.channels.find((c) => c.name === "telemetry")!.metadata.messageEncoding).toBe(
      "json",
    );
    // meter registered per file
    expect(allWorkloadSnapshots()[`viewer:${fileId}`]).toBeDefined();
    await h.dispose();
  });

  it("plays timestamp-paced through the standard frame transport, then stops at the end", async () => {
    const h = harness();
    const file = await writeFixture(await tempRoot());
    const { fileId } = await h.call<{ fileId: string }>("open", file);

    await h.call("play", { fileId, rate: 1 });
    await until(() => h.files()[fileId]?.playing === false);

    // Every cam frame published on the session's dynamic topic; aux too.
    const writes = h.transports.flatMap((t) => t.writes);
    const camWrites = writes.filter((w) => w.topic === `fr:viewer:${fileId}:cam`);
    expect(camWrites).toHaveLength(6);
    // Decoded payload carries the message bytes (fake decoder passthrough):
    // first cam frame was Uint16 [0,1,2,3].
    expect(Array.from(new Uint16Array(camWrites[0].bytes.slice().buffer))).toEqual([
      0, 1, 2, 3,
    ]);
    expect(writes.some((w) => w.topic === `fr:viewer:${fileId}:aux`)).toBe(true);
    // meta carries convertMs for the OSD/profiler timing path
    expect(camWrites[0].payload.meta?.convertMs).toBeDefined();

    // Pacing: messages sit 100 ms apart (aux at 0.35 s splits one gap into
    // 50+50) — the virtual clock recorded (nearly) the whole 500 ms span.
    const slept = h.clock.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeGreaterThan(450);
    expect(slept).toBeLessThanOrEqual(510);

    // telemetry docs (2 extras) replayed onto session telemetry
    expect(h.playbackDocs()[fileId]).toMatchObject({ stream: "cam", seq: 1 });

    // ended: position landed on the duration, playing false
    expect(h.files()[fileId].positionNs).toBe(0.5 * NS);

    // meter counted ingest + emits
    const meter = allWorkloadSnapshots()[`viewer:${fileId}`];
    expect(meter.inputs["cam"].count).toBe(6);
    expect(meter.outputs["frames"].count).toBe(7);
    expect(meter.outputs["telemetry"].count).toBe(2);
    await h.dispose();
  });

  it("rate scales the pacing schedule", async () => {
    const h = harness();
    const file = await writeFixture(await tempRoot());
    const { fileId } = await h.call<{ fileId: string }>("open", file);
    await h.call("play", { fileId, rate: 2 });
    await until(() => h.files()[fileId]?.playing === false);
    const slept = h.clock.sleeps.reduce((a, b) => a + b, 0);
    // 500 ms of media at 2× ≈ 250 ms wall
    expect(slept).toBeGreaterThan(220);
    expect(slept).toBeLessThanOrEqual(260);
    await h.dispose();
  });

  it("seek while paused republishes the latest frame at-or-before the target", async () => {
    const h = harness();
    const file = await writeFixture(await tempRoot());
    const { fileId } = await h.call<{ fileId: string }>("open", file);

    // tNs is RELATIVE to the first message (0.1 s absolute): 0.25 s relative
    // = 0.35 s absolute → cam's latest ≤ target is frame #2 (t=0.3 s abs,
    // bytes [2,3,4,5]); aux's is its only frame (exactly 0.35 s abs).
    await h.call("seek", { fileId, tNs: 0.25 * NS });
    await flush();
    const writes = h.transports.flatMap((t) => t.writes);
    const camWrites = writes.filter((w) => w.topic === `fr:viewer:${fileId}:cam`);
    expect(camWrites).toHaveLength(1);
    expect(Array.from(new Uint16Array(camWrites[0].bytes.slice().buffer))).toEqual([
      2, 3, 4, 5,
    ]);
    expect(writes.some((w) => w.topic === `fr:viewer:${fileId}:aux`)).toBe(true);
    expect(h.files()[fileId].positionNs).toBe(0.25 * NS);
    expect(h.files()[fileId].playing).toBe(false);
    await h.dispose();
  });

  it("opens multiple files concurrently, keyed by fileId", async () => {
    const h = harness();
    const fileA = await writeFixture(await tempRoot());
    const fileB = await writeFixture(await tempRoot());
    const a = await h.call<{ fileId: string }>("open", fileA);
    const b = await h.call<{ fileId: string }>("open", fileB);
    await flush();
    expect(a.fileId).not.toBe(b.fileId);
    expect(Object.keys(h.files()).sort()).toEqual([a.fileId, b.fileId].sort());
    expect(allWorkloadSnapshots()[`viewer:${a.fileId}`]).toBeDefined();
    expect(allWorkloadSnapshots()[`viewer:${b.fileId}`]).toBeDefined();
    await h.dispose();
  });

  it("footerless (crash-truncated) file: streaming fallback recovers, flags truncated", async () => {
    const h = harness();
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
    const file = join(dir, "recording.fovea");
    const { size } = await stat(file);
    await truncate(file, Math.floor(size * 0.6));

    const { fileId } = await h.call<{ fileId: string }>("open", file);
    await flush();
    const f = h.files()[fileId];
    expect(f.truncated).toBe(true);
    expect(f.channels.map((c) => c.name)).toContain("cam");
    expect(f.durationNs).toBeGreaterThan(0);

    await h.call("play", { fileId, rate: 1 });
    await until(() => h.files()[fileId]?.playing === false);
    const camWrites = h.transports
      .flatMap((t) => t.writes)
      .filter((w) => w.topic === `fr:viewer:${fileId}:cam`);
    expect(camWrites.length).toBeGreaterThan(0); // recovered flushed frames
    expect(camWrites.length).toBeLessThan(6); // but not the truncated tail
    await h.dispose();
  });

  it("close() removes the file from state and disposes its workload meter", async () => {
    const h = harness();
    const file = await writeFixture(await tempRoot());
    const { fileId } = await h.call<{ fileId: string }>("open", file);
    expect(allWorkloadSnapshots()[`viewer:${fileId}`]).toBeDefined();
    await h.call("close", fileId);
    await flush();
    expect(h.files()[fileId]).toBeUndefined();
    expect(allWorkloadSnapshots()[`viewer:${fileId}`]).toBeUndefined();
    await h.dispose();
  });

  it("session idle closes every open file (last viewer window gone)", async () => {
    installFakeFrameTransport();
    const session = viewerSession({ decoderFor: fakeDecoderFor, clock: virtualClock() });
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const client = new Channel(clientEp);
    session.attach(server);
    session.subscribe(server);

    const file = await writeFixture(await tempRoot());
    const { fileId } = await client.request<{ fileId: string }>(
      topic.command("viewer", "open"),
      file,
    );
    expect(allWorkloadSnapshots()[`viewer:${fileId}`]).toBeDefined();

    session.dispose(); // force-idle: unsubscribes everyone, runs idle()
    await session.drained();
    expect(allWorkloadSnapshots()[`viewer:${fileId}`]).toBeUndefined();
  });

  it("commands on an unknown fileId reject instead of crashing the session", async () => {
    const h = harness();
    await expect(h.call("play", { fileId: "nope", rate: 1 })).rejects.toThrow(
      /unknown fileId/,
    );
    await h.dispose();
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
    const file = join(dir, "recording.fovea");
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

  it("rejects a non-MCAP file cleanly (no zombie handle, clear error)", async () => {
    const dir = await tempRoot();
    const bogus = join(dir, "not-a-container.fovea");
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
