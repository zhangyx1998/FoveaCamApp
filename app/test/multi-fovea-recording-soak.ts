// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Multi-fovea recording END-TO-END soak (wave I-2). Drives the REAL recording
// controller — the refcounted raw-pipe registry over NATIVE raw12p taps
// (fake camera), the REAL zlib CompressStream brick on one stream, the real
// recorder node worker — through a free-run recording with DESCRIPTOR CHURN
// (targets armed/disarmed mid-run), then finalizes and decode-verifies:
//   (a) the raw12p channels recorded verbatim (packed advert geometry);
//   (b) the /zlib stream round-trips through the VIEWER decode path
//       (splitCodecs → decompressChain → base format) to full-size frames;
//   (c) descriptor channels churn mid-file, docs carry the documented
//       FREE-RUN shape (left:null, right:null, center: a valid recorded seq);
//   (d) advert-verbatim channel metadata (pixelFormat codec suffix,
//       significantBits injected by the advertiser);
//   (e) seek before a mid-file channel's first message = no message, no crash;
//   (f) full teardown: registry refcounts at zero, pipes retired.
// Live pair→descriptor binding is RIG-GATED (stage-f — fake cameras don't
// stamp device time and there is no FIN source here); the dts→seq re-keying
// is unit-tested in multi-fovea-recording.test.ts.
//
// NOT part of the unit gate — see vitest.soak.config.ts. Run with:
//   ../node_modules/.bin/vitest run -c vitest.soak.config.ts

import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aravis, Pipe, cleanup } from "core";
import { asBroker } from "@orchestrator/pipe-session";
import {
  createRawPipeRegistry,
  type RawPipeSeam,
} from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
import { createMultiFoveaRecording } from "../modules/multi-fovea/recording";
import type { MultiFoveaDescriptor } from "../modules/multi-fovea/recording";
import { openFovea } from "@orchestrator/viewer/source";
import { createFrameDecoder, splitCodecs } from "@orchestrator/viewer/decode";

const SOAK_MS = Number(process.env.SOAK_MS ?? 8_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachRawPipe(camera: unknown, pipeId: string): boolean;
  detachRawPipe(pipeId: string): boolean;
  attachRaw12pPipe(camera: unknown, pipeId: string): boolean;
  detachRaw12pPipe(pipeId: string): boolean;
  attachCompressPipe(src: string, id: string, options?: { level?: number }): boolean;
  detachCompressPipe(id: string): boolean;
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

describe("multi-fovea recording e2e soak (raw12p registry + zlib + descriptor churn)", () => {
  it(
    `records ~${SOAK_MS}ms free-run with churn, then decode-verifies`,
    { timeout: SOAK_MS + 60_000 },
    async () => {
      A.enableFakeCamera();
      const cams = await A.Camera.list();
      expect(cams.length).toBeGreaterThan(0);
      const camera = cams[0]!;

      // --- probe geometry (one grabbed frame; the fake negotiates Mono8) ----
      const probe = await camera.grab(2_000_000);
      const [Hh, Ww] = probe.raw.shape as [number, number];
      probe.release?.();

      // --- the REAL registry over the native raw12p taps --------------------
      const broker = asBroker(Pipe);
      const rawSeam: RawPipeSeam = {
        advertise: (spec) => broker.advertise(spec),
        unadvertise: (id) => (Pipe as unknown as { drop(id: string): void }).drop(id),
        attach: (kind, cam, id) =>
          void (kind === "raw12p" ? A.attachRaw12pPipe(cam, id) : A.attachRawPipe(cam, id)),
        detach: (kind, id) =>
          void (kind === "raw12p" ? A.detachRaw12pPipe(id) : A.detachRawPipe(id)),
      };
      const registry = createRawPipeRegistry(rawSeam);
      const compressSeam: CompressPipeSeam = {
        advertise: (spec) => broker.advertise(spec),
        unadvertise: (id) => (Pipe as unknown as { drop(id: string): void }).drop(id),
        attach: (src, id, opts) => void A.attachCompressPipe(src, id, opts),
        detach: (id) => void A.detachCompressPipe(id),
      };

      // Three raw12p taps off the one fake camera (bindings key by pipe id).
      const source = (serial: string) => ({
        serial,
        pixel_format: "Mono8",
        getFeatureInt: (n: string) => (n === "Width" ? Ww : Hh),
      });
      const finished: string[] = [];
      const rec = createMultiFoveaRecording({
        cameras: () => ({
          L: { source: source("fake-l"), camera },
          C: { source: source("fake-c"), camera },
          R: { source: source("fake-r"), camera },
        }),
        wideCamera: () => ({ sensor_size: { width: Ww, height: Hh } }),
        rawPipes: registry,
        connect: (pipeId) => {
          const h = broker.connect(pipeId);
          return {
            shmName: h.shmName,
            spec: h.spec,
            release: () => void broker.disconnect(pipeId),
          };
        },
        compress: compressSeam,
        // The LEFT stream routes through the REAL CompressStream brick.
        compressStreams: () => ({ left: true, center: false, right: false }),
        finished: (p) => void finished.push(p),
        telemetry: (patch) => {
          if (patch.recordingStreams && Object.keys(patch.recordingStreams).length)
            lastStats = patch.recordingStreams;
        },
      });
      let lastStats: unknown = null;

      // --- record with descriptor churn --------------------------------------
      const dir = await mkdtemp(join(tmpdir(), "mf-recording-soak-"));
      rec.onTargets([{ index: 0, enabled: true, streamId: null }]);
      expect(await rec.start(dir)).toBe(true);

      // Synthetic free-run tracker batches at ~25 Hz; target 1 arms mid-run
      // (mid-file descriptor channel) and target 0 disarms later.
      const t0 = Date.now();
      let batchSeq = 0;
      let target1On = false;
      let target0On = true;
      while (Date.now() - t0 < SOAK_MS) {
        const elapsed = Date.now() - t0;
        if (!target1On && elapsed > SOAK_MS * 0.3) {
          target1On = true;
          rec.onTargets([
            { index: 0, enabled: true, streamId: null },
            { index: 1, enabled: true, streamId: null },
          ]);
        }
        if (target0On && elapsed > SOAK_MS * 0.7) {
          target0On = false;
          rec.onTargets([{ index: 1, enabled: true, streamId: null }]);
        }
        const slots = [
          ...(target0On ? [0] : []),
          ...(target1On ? [1] : []),
        ];
        rec.onTrackBatch({
          seq: batchSeq++,
          targets: slots.map((i) => ({
            id: String(i),
            ok: true,
            bbox: { x: 32 + i * 100 + (batchSeq % 20), y: 48, width: 64, height: 64 },
            updateMs: 0.1,
          })),
        });
        await sleep(40);
      }
      console.log("[soak] final stream stats:", JSON.stringify(lastStats));
      expect(await rec.stop()).toBe(true);
      expect(finished.length).toBe(1);
      const foveaPath = finished[0]!;

      // Full teardown proof: registry refcounts at zero (producers retired).
      for (const s of ["fake-l", "fake-c", "fake-r"])
        expect(registry.refCount(`camera/${s}/raw12p`)).toBe(0);

      // --- decode-verify ------------------------------------------------------
      const src = await openFovea(foveaPath);
      try {
        const topics = src.channels.map((c) => c.topic);
        console.log("[soak] recorded channels:", JSON.stringify(topics));
        for (const expected of ["left", "center", "right", "fovea/0", "fovea/1"])
          expect(topics, `channel ${expected}`).toContain(expected);

        const byTopic = new Map(src.channels.map((c) => [c.topic, c]));
        // (d) advert-verbatim metadata: the compressed stream carries the codec
        // suffix; every raw12p channel carries the injected significantBits.
        const left = byTopic.get("left")!;
        expect(left.metadata.pixelFormat).toBe("Mono8/zlib");
        expect(splitCodecs(left.metadata.pixelFormat)).toEqual({
          base: "Mono8",
          codecs: ["zlib"],
        });
        for (const t of ["left", "center", "right"])
          expect(byTopic.get(t)!.metadata.significantBits).toBe("8");

        // Count messages per channel + capture the /zlib payloads and the
        // descriptor docs.
        const counts = new Map<string, number>();
        const leftPayloads: Uint8Array[] = [];
        const docs: Record<string, MultiFoveaDescriptor[]> = { "fovea/0": [], "fovea/1": [] };
        const firstLog = new Map<string, bigint>();
        const dec = new TextDecoder();
        const idToTopic = new Map(src.channels.map((c) => [c.id, c.topic]));
        for await (const msg of src.messages()) {
          const topic = idToTopic.get(msg.channelId)!;
          counts.set(topic, (counts.get(topic) ?? 0) + 1);
          if (!firstLog.has(topic)) firstLog.set(topic, msg.logTime);
          if (topic === "left" && leftPayloads.length < 5)
            leftPayloads.push(msg.data.slice());
          if (topic in docs)
            docs[topic]!.push(JSON.parse(dec.decode(msg.data)) as MultiFoveaDescriptor);
        }
        for (const t of ["left", "center", "right"])
          expect(counts.get(t) ?? 0, `frames on ${t}`).toBeGreaterThan(0);
        expect(docs["fovea/0"]!.length).toBeGreaterThan(0);
        expect(docs["fovea/1"]!.length).toBeGreaterThan(0);

        // (b) the /zlib stream round-trips through the viewer decode path:
        // per-frame independent blobs inflate to the full packed frame, and the
        // channel-metadata-driven decoder reshapes them (pure JS for Mono8).
        expect(leftPayloads.length).toBeGreaterThan(0);
        for (const blob of leftPayloads) {
          expect(blob.byteLength).toBeLessThan(Ww * Hh + 64); // actually compressed
          expect(inflateSync(blob).byteLength).toBe(Ww * Hh);
        }
        const decodeLeft = await createFrameDecoder(left.metadata);
        const mat = decodeLeft(leftPayloads[0]!);
        expect(mat.byteLength).toBe(Ww * Hh);
        expect((mat as unknown as { shape: number[] }).shape).toEqual([Hh, Ww]);

        // (c) descriptor docs: the documented FREE-RUN shape.
        const centerCount = counts.get("center") ?? 0;
        for (const doc of [...docs["fovea/0"]!, ...docs["fovea/1"]!]) {
          expect(doc.frames.left).toBeNull();
          expect(doc.frames.right).toBeNull();
          expect(doc.bbox.width).toBe(64);
          if (doc.frames.center !== null) {
            expect(doc.frames.center).toBeGreaterThanOrEqual(0);
            expect(doc.frames.center).toBeLessThan(centerCount);
          }
        }

        // Mid-file channel: fovea/1 starts strictly after fovea/0.
        expect(firstLog.get("fovea/1")! > firstLog.get("fovea/0")!).toBe(true);

        // (e) seek before a mid-file channel's first message → absent, no crash.
        const before = await src.latestBefore(src.startNs, ["fovea/1"]);
        expect(before.has("fovea/1")).toBe(false);
      } finally {
        await src.close();
        camera.release?.();
        await rm(dir, { recursive: true, force: true });
        cleanup();
      }
    },
  );
});
