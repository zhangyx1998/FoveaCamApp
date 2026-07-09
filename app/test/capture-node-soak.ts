// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 3 SOAK. Drives the ACTUAL capture node (its real
// worker thread + real `core/Vision`) over NATIVE fake-camera raw pipes,
// running a 3-shot RASTER (indexed accumulation), then proves:
//   (a) the node holds one resource per shot — the `capture_meta` manifest has
//       wide (once) + per-shot arrays of fovea/center/left/right/diff;
//   (b) getPreview returns the node's ACTUAL held data (ruling 7) at 8-bit BGRA
//       with correct dims/channels/depth (4-ch for the wrapped foveae + diff,
//       source-ch for the sliced center; meta-only resources → null);
//   (c) save() writes files in-worker (per-resource dirs + a `wide.json`);
//   (d) discard() clears the held resources (getPreview → null after).
//
// NOT part of the unit gate — see vitest.soak.config.ts. Run with:
//   ../node_modules/.bin/vitest run -c vitest.soak.config.ts

import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aravis, Pipe, cleanup } from "core";
import { createCaptureNode, type CaptureShot } from "@orchestrator/capture-node";

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

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe("capture node soak (real worker + native raw pipes + core/Vision)", () => {
  it("runs a 3-shot raster, previews the held data, saves + discards", async () => {
    A.enableFakeCamera();
    const cams = await A.Camera.list();
    expect(cams.length).toBeGreaterThan(0);
    const camera = cams[0]!;

    // --- probe sensor geometry (one grabbed frame) -------------------------
    const probe = await camera.grab(2_000_000);
    const shape = probe.raw.shape as number[];
    const [Hh, Ww] = shape as [number, number];
    const CH = probe.raw.channels ?? (shape.length === 3 ? shape[2]! : 1);
    const BPE = probe.raw.BYTES_PER_ELEMENT;
    probe.release?.();
    const bytesPerFrame = Ww * Hh * CH * BPE;
    const dtype = BPE > 1 ? "U16" : "U8";
    const pixelFormat = "Mono8";

    // --- advertise + attach 3 raw pipes (left / right / center) off one cam -
    const ROLES = ["left", "right", "center"] as const;
    const pipeId = (r: string) => `camera/${camera.serial ?? "1"}/raw/${r}`;
    const specById = new Map<string, Record<string, unknown>>();
    const attached: string[] = [];
    for (const r of ROLES) {
      const id = pipeId(r);
      const spec = {
        id, pixelFormat, dtype, width: Ww, height: Hh, channels: CH,
        stride: Ww * CH * BPE, bytesPerFrame, ringDepth: 8,
      };
      specById.set(id, spec);
      P.advertise(spec);
      expect(A.attachRawPipe(camera, id), `attach ${id}`).toBe(true);
      attached.push(id);
    }

    // --- on-demand acquire seam (advertise/attach already done; connect only) -
    const streamInit = (shmName: string) => ({
      shmName,
      maxBytes: bytesPerFrame,
      channels: CH,
      bytesPerElement: BPE,
      significantBits: 8,
      pixelFormat,
    });
    let acquisitions = 0;
    const acquireStreams = () => {
      acquisitions++;
      const cL = P.connect(pipeId("left"));
      const cR = P.connect(pipeId("right"));
      const cC = P.connect(pipeId("center"));
      return {
        streams: {
          left: streamInit(cL.shmName),
          right: streamInit(cR.shmName),
          center: { shmName: cC.shmName, maxBytes: bytesPerFrame, channels: CH },
        },
        release: () => {
          P.disconnect(pipeId("left"));
          P.disconnect(pipeId("right"));
          P.disconnect(pipeId("center"));
        },
      };
    };

    const node = createCaptureNode({
      id: "capture/soak",
      graphInputs: { left: pipeId("left"), right: pipeId("right"), center: pipeId("center") },
      acquireStreams,
    });

    const shot = (i: number): CaptureShot => ({
      reset: i === 0,
      indexed: true,
      stackCount: 3,
      H_L: IDENTITY,
      H_R: IDENTITY,
      rect: { x: 0, y: 0, width: Math.min(8, Ww), height: Math.min(8, Hh) },
      meta: {
        wide: i === 0 ? { sensor_size: { width: Ww, height: Hh } } : undefined,
        fovea: { Q: IDENTITY, baseline: 200, "baseline.unit": "millimeter" },
        left: { volt: { x: i, y: -i }, "volt.unit": "volt" },
        right: { volt: { x: -i, y: i }, "volt.unit": "volt" },
      },
    });

    // --- 3-shot raster -----------------------------------------------------
    let manifest: Record<string, unknown> = {};
    for (let i = 0; i < 3; i++) manifest = await node.capture(shot(i));

    // (a) manifest: wide once (unindexed), the rest per-shot arrays of length 3
    expect(manifest.wide).toEqual({ sensor_size: { width: Ww, height: Hh } });
    for (const name of ["fovea", "center", "left", "right", "diff"]) {
      expect(Array.isArray(manifest[name]), `${name} indexed`).toBe(true);
      expect((manifest[name] as unknown[]).length).toBe(3);
    }
    // center + diff are image-only → null meta entries
    expect(manifest.center).toEqual([null, null, null]);
    expect((manifest.left as unknown[])[2]).toEqual({ volt: { x: 2, y: -2 }, "volt.unit": "volt" });
    expect(acquisitions).toBe(3); // one on-demand connect per shot

    // (b) getPreview = the node's ACTUAL held resources (8-bit BGRA)
    for (let i = 0; i < 3; i++) {
      const left = await node.getPreview("left", i);
      expect(left, `left[${i}] preview`).toBeTruthy();
      expect(left!.shape).toEqual([Hh, Ww]); // wrapped fovea keeps sensor dims
      expect(left!.channels).toBe(4); // makeBGRA → BGRA
      expect(left!.data!.byteLength).toBe(Hh * Ww * 4); // 8-bit
      const diff = await node.getPreview("diff", i);
      expect(diff!.channels).toBe(4);
    }
    // center: sliced source-channel region, 8-bit
    const center0 = await node.getPreview("center", 0);
    expect(center0!.channels).toBe(CH);
    expect(center0!.shape).toEqual([Math.min(8, Hh), Math.min(8, Ww)]);
    // default index → latest entry
    const leftLatest = await node.getPreview("left");
    expect(leftLatest!.shape).toEqual([Hh, Ww]);
    // meta-only resources have no image
    expect(await node.getPreview("wide")).toBeNull();
    expect(await node.getPreview("fovea", 0)).toBeNull();

    // (c) save writes files in-worker
    const dir = await mkdtemp(join(tmpdir(), "fovea-cap-soak-"));
    await node.save(dir, "png");
    const top = await readdir(dir);
    expect(top).toEqual(expect.arrayContaining(["wide.json", "fovea", "center", "left", "right", "diff"]));
    const leftFiles = await readdir(join(dir, "left"));
    expect(leftFiles).toEqual(expect.arrayContaining(["00.png", "01.png", "02.png", "00.json"]));
    expect((await stat(join(dir, "left", "00.png"))).size).toBeGreaterThan(0);
    // save clears the held resources
    expect(await node.getPreview("left", 0)).toBeNull();

    // (d) discard clears
    await node.capture(shot(0)); // reset single accumulation
    expect(await node.getPreview("left", 0)).toBeTruthy();
    await node.discard();
    expect(await node.getPreview("left", 0)).toBeNull();

    // --- teardown ----------------------------------------------------------
    await node.stop();
    for (const id of attached) {
      A.detachRawPipe(id);
      P.close(id);
      P.drop(id);
    }
    camera.release?.();
    await rm(dir, { recursive: true, force: true });
    cleanup();

    // eslint-disable-next-line no-console
    console.log("\n[capture-soak] " + JSON.stringify({ Ww, Hh, CH, BPE, acquisitions, resources: Object.keys(manifest) }, null, 2));
  });
});
