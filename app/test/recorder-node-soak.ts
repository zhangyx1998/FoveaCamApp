// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// multi-fovea-recording Wave I-1a CHURN SOAK. Drives the ACTUAL recorder node
// (its real worker thread + the real MCAP writer) over NATIVE fake-camera raw
// pipes for ~10-20s while CHURNING streams the way multi-fovea does, then
// finalizes and DECODES the `.fovea` to prove:
//   (a) exact frame accounting on the STABLE (whole-recording) streams —
//       decoded messages/channel == worker `written`, mcap sequences contiguous
//       0..N-1 (zero unexplained write loss), written+drops >= published span;
//   (b) a CHURNED frame stream added + removed mid-run records a mid-file
//       channel with contiguous 0..N-1 sequences (drain-the-tail on removal);
//   (c) DESCRIPTOR (data) channels added/removed mid-run carry JSON docs
//       ({tNs, bbox, frames}) — count == posted, structure intact, mid-file;
//   (d) the GLOBAL wide cameraMatrix metadata record is present + decodes;
//   (e) VERBATIM advert metadata on frame channels (stride/significantBits/
//       width/height copied from the advert, pixelFormat opaque);
//   (f) logTime is a single monotonic clock across EVERY channel; the viewer's
//       relative domain still starts at 0 (messageStartTime anchor).
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

describe("recorder node churn soak (dynamic streams + descriptors + camera matrix)", () => {
  it(`records ~${SOAK_MS}ms churning streams+descriptors, then decodes with exact accounting`, async () => {
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
    const stride = Ww * CH * BPE;
    const bytesPerFrame = stride * Hh;
    const dtype = BPE > 1 ? "U16" : "U8";
    const pixelFormat = "Mono8"; // fake camera readout label
    const SIG_BITS = 8;

    // --- advertise + attach raw pipes off the one fake camera --------------
    // 3 STATIC streams (whole recording) + 1 CHURNED (added/removed mid-run).
    const STATIC = ["left-fovea", "center", "right-fovea"] as const;
    const CHURNED = "extra-fovea";
    const ALL_PIPES = [...STATIC, CHURNED];
    const pipeIdFor = (name: string) => `camera/${camera.serial ?? "1"}/raw/${name}`;
    const specById = new Map<string, Record<string, unknown>>();
    const attached: string[] = [];
    for (const name of ALL_PIPES) {
      const id = pipeIdFor(name);
      const spec = {
        id,
        pixelFormat,
        dtype,
        width: Ww,
        height: Hh,
        channels: CH,
        stride,
        bytesPerFrame,
        significantBits: SIG_BITS,
        ringDepth: 48,
      };
      specById.set(id, spec);
      P.advertise(spec);
      const ok = A.attachRawPipe(camera, id);
      expect(ok, `attachRawPipe(${id})`).toBe(true);
      attached.push(id);
    }

    // --- connect seam (broker stand-in) — copies advert fields VERBATIM ----
    const connect = (pipeId: string): RecorderPipeConnection => {
      const { shmName } = P.connect(pipeId);
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
          stride: spec.stride as number,
          significantBits: spec.significantBits as number,
          maxBytes: spec.bytesPerFrame as number,
        },
        release: () => void P.disconnect(pipeId),
      };
    };

    const dir = await mkdtemp(join(tmpdir(), "fovea-churn-soak-"));
    // Only the STATIC streams start with the recording; CHURNED is added later.
    const streams = Object.fromEntries(
      STATIC.map((name) => [name, { pipeId: pipeIdFor(name) }]),
    );

    // ruling-4 extras: L/R foveae carry a (fake) volt/H doc, center wide none.
    const MIRROR: Record<string, "L" | "R" | null> = {
      "left-fovea": "L",
      center: null,
      "right-fovea": "R",
      [CHURNED]: "R",
    };
    const cameraMatrix = {
      matrix: [
        [1000, 0, Ww / 2],
        [0, 1000, Hh / 2],
        [0, 0, 1],
      ],
      distortion: [0.1, -0.2, 0, 0, 0.05],
      model: "pinhole",
    };
    const node = createRecorderNode({
      id: "recorder/churn-soak",
      path: dir,
      streams,
      connect,
      timestamp: new Date().toISOString(),
      cameraMatrix,
      onFrame: (streamName, _seq, tNs) => {
        if (!MIRROR[streamName]) return null;
        expect(typeof tNs).toBe("bigint");
        return { volt: { x: 1.5, y: -2.25 }, "volt.unit": "volt", H: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
      },
    });

    // --- soak with churn --------------------------------------------------
    // track-1: added at start, descriptors every tick, removed at ~80%.
    // track-2: added at ~50%, descriptors, kept to the end.
    // extra-fovea frame stream: added ~30%, removed ~65% (drain-the-tail).
    node.addDataStream("fovea/track-1");
    const descriptorPosts: Record<string, number> = { "fovea/track-1": 0, "fovea/track-2": 0 };
    let addedExtra = false;
    let removedExtra = false;
    let addedTrack2 = false;
    let removedTrack1 = false;
    let seqPointer = 0;

    const started = Date.now();
    while (Date.now() - started < SOAK_MS) {
      await sleep(250);
      const frac = (Date.now() - started) / SOAK_MS;
      if (!addedExtra && frac > 0.3) {
        node.addStream(CHURNED, { pipeId: pipeIdFor(CHURNED) });
        addedExtra = true;
      }
      if (!addedTrack2 && frac > 0.5) {
        node.addDataStream("fovea/track-2");
        addedTrack2 = true;
      }
      if (!removedExtra && frac > 0.65) {
        node.removeStream(CHURNED);
        removedExtra = true;
      }
      if (!removedTrack1 && frac > 0.8) {
        node.removeDataStream("fovea/track-1");
        removedTrack1 = true;
      }
      seqPointer += 1;
      const descriptor = {
        bbox: { x: 10, y: 20, width: 30, height: 40 },
        frames: { left: seqPointer, center: seqPointer, right: seqPointer },
      };
      if (!removedTrack1) {
        node.postData("fovea/track-1", { tNs: Date.now() * 1e6, ...descriptor });
        descriptorPosts["fovea/track-1"] += 1;
      }
      if (addedTrack2) {
        node.postData("fovea/track-2", { tNs: Date.now() * 1e6, ...descriptor });
        descriptorPosts["fovea/track-2"] += 1;
      }
      node.stats(); // exercise the low-rate UI-stats path during the soak
    }

    // Sample each STATIC producer's published latest seq on a MAIN-side reader
    // BEFORE finalize (connections unmap on release) — the independent ground
    // truth for "published" against which written + drops must reconcile.
    const addon = createRequire(import.meta.url)(readerAddonPath()) as {
      open(name: string): object;
      latestSeq(h: object): bigint;
      close(h: object): void;
    };
    const publishedAtStop: Record<string, number> = {};
    for (const name of STATIC) {
      const { shmName } = P.connect(pipeIdFor(name)); // extra refcount; released below
      const h = addon.open(shmName);
      publishedAtStop[name] = Number(addon.latestSeq(h));
      addon.close(h);
      P.disconnect(pipeIdFor(name));
    }

    const elapsedSec = (Date.now() - started) / 1000;
    const finalize = await node.stop();
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
      read: async (offset, length) => buf.subarray(Number(offset), Number(offset + length)),
    };
    const reader = await McapIndexedReader.Initialize({ readable });

    // (d) metadata records present — incl. the wide cameraMatrix singleton.
    const metaRecords = new Map<string, Map<string, string>>();
    for await (const m of reader.readMetadata()) metaRecords.set(m.name, new Map(m.metadata));
    expect([...metaRecords.keys()]).toEqual(
      expect.arrayContaining(["fovea:session", "fovea:finalize", "fovea:wide-camera"]),
    );
    expect(metaRecords.get("fovea:session")!.has("timestamp")).toBe(true);
    expect(metaRecords.get("fovea:finalize")!.has("durationSec")).toBe(true);
    const cam = metaRecords.get("fovea:wide-camera")!;
    expect(JSON.parse(cam.get("matrix")!)).toEqual(cameraMatrix.matrix);
    expect(JSON.parse(cam.get("distortion")!)).toEqual(cameraMatrix.distortion);
    expect(cam.get("model")).toBe("pinhole");

    // channels: static frames + churned frame + 2 descriptor + 1 telemetry
    const channels = [...reader.channelsById.values()];
    const byTopic = new Map(channels.map((c) => [c.topic, c]));
    for (const name of [...STATIC, CHURNED]) {
      const ch = byTopic.get(name);
      expect(ch, `channel ${name}`).toBeTruthy();
      const md = ch!.metadata;
      // (e) VERBATIM advert metadata.
      const parsedShape = JSON.parse(md.get("shape")!);
      expect(parsedShape).toEqual(CH > 1 ? [Hh, Ww, CH] : [Hh, Ww]);
      expect(md.get("dtype")).toBe(dtype);
      expect(md.get("width")).toBe(String(Ww));
      expect(md.get("height")).toBe(String(Hh));
      expect(md.get("channels")).toBe(String(CH));
      expect(md.get("pixelFormat")).toBe(pixelFormat);
      expect(md.get("significantBits")).toBe(String(SIG_BITS));
      expect(md.get("stride")).toBe(String(stride)); // advert's own number
    }
    expect(byTopic.has("telemetry")).toBe(true);
    expect(byTopic.has("fovea/track-1")).toBe(true);
    expect(byTopic.has("fovea/track-2")).toBe(true);

    // Walk every message once (readMessages yields in logTime order).
    const perChannelSeqs = new Map<string, number[]>();
    const telemetryDocs: Array<{ stream: string; seq: number; t: number }> = [];
    const descriptorDocs = new Map<string, Array<Record<string, unknown>>>();
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
      } else if (topic.startsWith("fovea/")) {
        const doc = JSON.parse(new TextDecoder().decode(msg.data));
        const arr = descriptorDocs.get(topic) ?? [];
        arr.push(doc);
        descriptorDocs.set(topic, arr);
      } else {
        const arr = perChannelSeqs.get(topic) ?? [];
        arr.push(Number(msg.sequence));
        perChannelSeqs.set(topic, arr);
      }
    }

    // (f) single monotonic clock + 0-based relative domain
    expect(monotonic).toBe(true);
    const stats = reader.statistics!;
    expect(stats.messageStartTime).toBe(minLogTime);
    expect(stats.messageEndTime).toBe(maxLogTime);
    expect(Number(minLogTime! - stats.messageStartTime)).toBe(0);

    // (a) exact accounting on the STABLE streams
    const report: Record<string, unknown> = {};
    for (const name of STATIC) {
      const seqs = perChannelSeqs.get(name) ?? [];
      const written = finalStats[name]?.frames ?? 0;
      const dropped = finalStats[name]?.dropped ?? 0;
      expect(seqs.length, `${name} decoded==written`).toBe(written);
      for (let i = 0; i < seqs.length; i++)
        expect(seqs[i], `${name} contiguous seq @${i}`).toBe(i);
      const accounted = written + dropped;
      const published = publishedAtStop[name]!;
      const slack = accounted - published;
      report[name] = { written, dropped, accounted, published, slack, fps: finalStats[name]?.fps };
      expect(slack, `${name} no unexplained loss (accounted>=published)`).toBeGreaterThanOrEqual(0);
      expect(slack, `${name} accounting tight (<=1s of frames)`).toBeLessThanOrEqual(
        Math.ceil(finalStats[name]?.fps ?? 60),
      );
    }

    // (b) the CHURNED frame stream: a mid-file channel, contiguous 0..N-1,
    // decoded == worker-written (drain-the-tail delivered the whole tail).
    const churnSeqs = perChannelSeqs.get(CHURNED) ?? [];
    const churnWritten = finalStats[CHURNED]?.frames ?? 0;
    expect(churnWritten, "churned stream recorded frames").toBeGreaterThan(0);
    expect(churnSeqs.length, "churned decoded==written").toBe(churnWritten);
    for (let i = 0; i < churnSeqs.length; i++)
      expect(churnSeqs[i], `churned contiguous seq @${i}`).toBe(i);
    report[CHURNED] = { written: churnWritten, decoded: churnSeqs.length };

    // (c) descriptor channels: count == posted, structure intact.
    for (const name of ["fovea/track-1", "fovea/track-2"]) {
      const docs = descriptorDocs.get(name) ?? [];
      expect(docs.length, `${name} descriptor count == posted`).toBe(descriptorPosts[name]);
      expect(docs.length, `${name} posted at least one`).toBeGreaterThan(0);
      for (const d of docs) {
        expect(typeof d.tNs).toBe("number");
        expect(d.bbox).toMatchObject({ x: 10, y: 20, width: 30, height: 40 });
        expect((d.frames as Record<string, number>).left).toBeGreaterThan(0);
      }
    }

    // telemetry docs correlate stream+seq with a real frame sequence
    for (const doc of telemetryDocs) {
      expect(MIRROR[doc.stream]).toBeTruthy(); // only L/R + churned produce extras
      expect(perChannelSeqs.get(doc.stream)!).toContain(doc.seq);
      expect(Number.isFinite(doc.t)).toBe(true);
    }
    // center never carries extras
    expect(telemetryDocs.some((d) => d.stream === "center")).toBe(false);

    expect(Number(finalize.bytes)).toBeGreaterThan(0);
    expect(fileBytes).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      "\n[churn-soak] " +
        JSON.stringify(
          {
            elapsedSec: Number(elapsedSec.toFixed(1)),
            fileMB: Number((fileBytes / 1e6).toFixed(2)),
            messageCount: finalize.messageCount,
            chunkCount: finalize.chunkCount,
            telemetryDocs: telemetryDocs.length,
            descriptorPosts,
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
