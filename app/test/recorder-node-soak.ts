// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Wave R-2 SOAK. Drives the ACTUAL recorder node (its
// real worker thread + the real MCAP writer) over NATIVE fake-camera raw pipes
// for ~10-20s, then finalizes and DECODES the `.fovea` to prove:
//   (a) exact frame accounting — decoded messages/channel == worker `written`,
//       mcap sequences contiguous (zero unexplained write loss), and
//       written + ring-drops reconciles with the producer's published span;
//   (b) the container decodes — per-channel x-fovea-raw metadata, one telemetry
//       channel, `fovea:session` + `fovea:finalize` metadata records, telemetry
//       docs correlate stream+seq and survive after-frame physical ordering;
//   (c) shape metadata parity ([H,W] mono / [H,W,C] multi-channel);
//   (d) logTime is a single monotonic clock across EVERY channel and the
//       viewer's relative domain still starts at 0 (messageStartTime anchor).
//
// NOT part of the unit gate — see vitest.soak.config.ts. Run with:
//   ../node_modules/.bin/vitest run -c vitest.soak.config.ts

import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Aravis, Pipe, cleanup } from "core";
import { McapIndexedReader } from "@mcap/core";
import {
  createRecorderNode,
  type RecorderPipeConnection,
} from "@orchestrator/recorder-node";
import { readerAddonPath } from "@orchestrator/vision-worker-host";

const SOAK_MS = Number(process.env.SOAK_MS ?? 12_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachRawPipe(camera: unknown, pipeId: string): boolean;
  detachRawPipe(pipeId: string): boolean;
  Camera: {
    list(): Promise<
      Array<{
        serial?: string;
        grab(t: number): Promise<{
          raw: { shape: number[]; channels?: number; BYTES_PER_ELEMENT: number };
          release?(): void;
        }>;
        release?(): void;
      }>
    >;
  };
};
const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): number;
  connect(id: string): { shmName: string };
  disconnect(id: string): number;
  close(id: string): void;
  drop(id: string): void;
};

interface McapReadable {
  size(): Promise<bigint>;
  read(offset: bigint, length: bigint): Promise<Uint8Array>;
}

describe("recorder node soak (real worker + native pipes + mcap decode)", () => {
  it(`records ~${SOAK_MS}ms across 3 channels then decodes with exact accounting`, async () => {
    A.enableFakeCamera();
    const cams = await A.Camera.list();
    expect(cams.length).toBeGreaterThan(0);
    const camera = cams[0]!;

    // --- probe the sensor geometry (one grabbed frame) ---------------------
    const probe = await camera.grab(2_000_000);
    const shape = probe.raw.shape as number[];
    const [Hh, Ww] = shape as [number, number];
    const CH = probe.raw.channels ?? (shape.length === 3 ? shape[2]! : 1);
    const BPE = probe.raw.BYTES_PER_ELEMENT;
    probe.release?.();
    const bytesPerFrame = Ww * Hh * CH * BPE;
    const dtype = BPE > 1 ? "U16" : "U8";
    const pixelFormat = "Mono8"; // fake camera readout label

    // --- advertise + attach 3 raw pipes off the one fake camera ------------
    const CHANNELS = ["left-fovea", "center", "right-fovea"] as const;
    const pipeIdFor = (name: string) => `camera/${camera.serial ?? "1"}/raw/${name}`;
    const specById = new Map<string, Record<string, unknown>>();
    const attached: string[] = [];
    for (const name of CHANNELS) {
      const id = pipeIdFor(name);
      const spec = {
        id,
        pixelFormat,
        dtype,
        width: Ww,
        height: Hh,
        channels: CH,
        stride: Ww * CH * BPE,
        bytesPerFrame,
        ringDepth: 48,
      };
      specById.set(id, spec);
      P.advertise(spec);
      const ok = A.attachRawPipe(camera, id);
      expect(ok, `attachRawPipe(${id})`).toBe(true);
      attached.push(id);
    }

    // --- connect seam (broker stand-in) ------------------------------------
    const connected: string[] = [];
    const connect = (pipeId: string): RecorderPipeConnection => {
      const { shmName } = P.connect(pipeId);
      connected.push(pipeId);
      const spec = specById.get(pipeId)!;
      return {
        shmName,
        spec: {
          pixelFormat: spec.pixelFormat as string,
          dtype: spec.dtype as string,
          width: spec.width as number,
          height: spec.height as number,
          channels: spec.channels as number,
          bytesPerFrame: spec.bytesPerFrame as number,
          maxBytes: spec.bytesPerFrame as number,
        },
        release: () => void P.disconnect(pipeId),
      };
    };

    const dir = await mkdtemp(join(tmpdir(), "fovea-soak-"));
    const streams = Object.fromEntries(
      CHANNELS.map((name) => [name, { pipeId: pipeIdFor(name) }]),
    );

    // ruling-3 extras: L/R foveae carry a (fake) volt/angle doc, center none.
    const MIRROR: Record<string, "L" | "R" | null> = {
      "left-fovea": "L",
      center: null,
      "right-fovea": "R",
    };
    const extrasSeen = new Map<string, number>(); // stream -> count dispatched
    const node = createRecorderNode({
      id: "recorder/soak",
      path: dir,
      streams,
      connect,
      timestamp: new Date().toISOString(),
      onFrame: (stream, _seq, tNs) => {
        if (!MIRROR[stream]) return null;
        expect(typeof tNs).toBe("bigint");
        extrasSeen.set(stream, (extrasSeen.get(stream) ?? 0) + 1);
        return {
          volt: { x: 1.5, y: -2.25 },
          "volt.unit": "volt",
          "volt.source": "live-snapshot",
          angle: { x: 0.1, y: 0.2 },
          "angle.unit": "radian",
        };
      },
    });

    // --- soak -------------------------------------------------------------
    const started = Date.now();
    while (Date.now() - started < SOAK_MS) {
      await sleep(500);
      node.stats(); // exercise the low-rate UI-stats path during the soak
    }

    // Sample each producer's published latest seq on a MAIN-side reader BEFORE
    // finalize (the connections unmap on release) — the independent ground
    // truth for "published" against which written + drops must reconcile.
    const addon = createRequire(import.meta.url)(readerAddonPath()) as {
      open(name: string): object;
      latestSeq(h: object): bigint;
      close(h: object): void;
    };
    const publishedAtStop: Record<string, number> = {};
    for (const name of CHANNELS) {
      const { shmName } = P.connect(pipeIdFor(name)); // extra refcount; released below
      const h = addon.open(shmName);
      publishedAtStop[name] = Number(addon.latestSeq(h));
      addon.close(h);
      P.disconnect(pipeIdFor(name));
    }

    const elapsedSec = (Date.now() - started) / 1000;
    const finalize = await node.stop();
    // Final counts: stop() folds the worker's finalize stats push (the tail
    // drained past our last in-loop sample) before it resolves.
    const finalStats = node.stats();

    // Retire producers (consumers already released inside node.stop()).
    for (const id of attached) {
      A.detachRawPipe(id);
      P.close(id);
      P.drop(id);
    }
    camera.release?.();

    // --- decode -----------------------------------------------------------
    const filePath = node.filePath;
    const fileBytes = await stat(filePath).then((s) => s.size);
    const buf = await readFile(filePath);
    const readable: McapReadable = {
      size: async () => BigInt(buf.byteLength),
      read: async (offset, length) =>
        buf.subarray(Number(offset), Number(offset + length)),
    };
    const reader = await McapIndexedReader.Initialize({ readable });

    // (b) metadata records present
    const metaRecords = new Map<string, Map<string, string>>();
    for await (const m of reader.readMetadata())
      metaRecords.set(m.name, new Map(m.metadata));
    expect([...metaRecords.keys()]).toEqual(
      expect.arrayContaining(["fovea:session", "fovea:finalize"]),
    );
    expect(metaRecords.get("fovea:session")!.has("timestamp")).toBe(true);
    expect(metaRecords.get("fovea:finalize")!.has("durationSec")).toBe(true);

    // channels: 3 frame + 1 telemetry
    const channels = [...reader.channelsById.values()];
    const byTopic = new Map(channels.map((c) => [c.topic, c]));
    for (const name of CHANNELS) {
      const ch = byTopic.get(name);
      expect(ch, `channel ${name}`).toBeTruthy();
      const md = ch!.metadata;
      // (c) shape parity: mono → [H,W]; multi-channel → [H,W,C]
      const parsedShape = JSON.parse(md.get("shape")!);
      expect(parsedShape).toEqual(CH > 1 ? [Hh, Ww, CH] : [Hh, Ww]);
      expect(md.get("dtype")).toBe(dtype);
      expect(md.get("channels")).toBe(String(CH));
      expect(md.get("pixelFormat")).toBe(pixelFormat);
      expect(md.get("significantBits")).toBeTruthy();
    }
    expect(byTopic.has("telemetry")).toBe(true);

    // Walk every message once (readMessages yields in logTime order).
    const perChannelSeqs = new Map<string, number[]>();
    const telemetryDocs: Array<{ stream: string; seq: number; t: number }> = [];
    const idToTopic = new Map(channels.map((c) => [c.id, c.topic]));
    let prevLogTime = -1n;
    let monotonic = true;
    let minLogTime: bigint | null = null;
    let maxLogTime: bigint | null = null;
    for await (const msg of reader.readMessages()) {
      if (msg.logTime < prevLogTime) monotonic = false;
      prevLogTime = msg.logTime;
      if (minLogTime === null || msg.logTime < minLogTime) minLogTime = msg.logTime;
      if (maxLogTime === null || msg.logTime > maxLogTime) maxLogTime = msg.logTime;
      const topic = idToTopic.get(msg.channelId)!;
      if (topic === "telemetry") {
        const doc = JSON.parse(new TextDecoder().decode(msg.data));
        telemetryDocs.push({ stream: doc.stream, seq: doc.seq, t: doc.t });
      } else {
        const arr = perChannelSeqs.get(topic) ?? [];
        arr.push(Number(msg.sequence));
        perChannelSeqs.set(topic, arr);
      }
    }

    // (d) single monotonic clock + 0-based relative domain
    expect(monotonic).toBe(true);
    const stats = reader.statistics!;
    expect(stats.messageStartTime).toBe(minLogTime);
    expect(stats.messageEndTime).toBe(maxLogTime);
    // Relative domain starts at 0 (viewer subtracts messageStartTime).
    expect(Number(minLogTime! - stats.messageStartTime)).toBe(0);

    // (a) exact accounting per channel
    const report: Record<string, unknown> = {};
    for (const name of CHANNELS) {
      const seqs = perChannelSeqs.get(name) ?? [];
      const written = finalStats[name]?.frames ?? 0;
      const dropped = finalStats[name]?.dropped ?? 0;
      // decoded count == worker-reported written (final stats push in finalize)
      expect(seqs.length, `${name} decoded==written`).toBe(written);
      // mcap sequences contiguous 0..N-1 — no lost write between ingest + file
      for (let i = 0; i < seqs.length; i++)
        expect(seqs[i], `${name} contiguous seq @${i}`).toBe(i);
      // written + ring drops reconciles with the producer's published span.
      // (main-side latest sampled a hair before finalize → worker may drain a
      // few more; allow a tiny latch/connect-race slack, never NEGATIVE loss.)
      const accounted = written + dropped;
      const published = publishedAtStop[name]!;
      const slack = accounted - published;
      report[name] = { written, dropped, accounted, published, slack, fps: finalStats[name]?.fps };
      expect(slack, `${name} no unexplained loss (accounted>=published)`).toBeGreaterThanOrEqual(0);
      expect(slack, `${name} accounting tight (<=1s of frames)`).toBeLessThanOrEqual(
        Math.ceil((finalStats[name]?.fps ?? 60)),
      );
    }

    // telemetry docs correlate stream+seq with an existing frame sequence
    for (const doc of telemetryDocs) {
      expect(MIRROR[doc.stream]).toBeTruthy(); // only L/R produce extras
      expect(perChannelSeqs.get(doc.stream)!).toContain(doc.seq);
      expect(Number.isFinite(doc.t)).toBe(true);
    }
    // one telemetry doc per dispatched-extras frame that actually got written
    for (const name of ["left-fovea", "right-fovea"]) {
      const docs = telemetryDocs.filter((d) => d.stream === name).length;
      expect(docs).toBeGreaterThan(0);
      expect(docs).toBeLessThanOrEqual(finalStats[name]?.frames ?? 0);
    }
    // center never carries extras
    expect(telemetryDocs.some((d) => d.stream === "center")).toBe(false);

    // finalize stats sanity
    expect(Number(finalize.bytes)).toBeGreaterThan(0);
    expect(fileBytes).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      "\n[soak] " +
        JSON.stringify(
          {
            elapsedSec: Number(elapsedSec.toFixed(1)),
            fileMB: Number((fileBytes / 1e6).toFixed(2)),
            messageCount: finalize.messageCount,
            chunkCount: finalize.chunkCount,
            telemetryDocs: telemetryDocs.length,
            channels: report,
          },
          null,
          2,
        ),
    );

    await rm(dir, { recursive: true, force: true });
    cleanup();
  });
});
