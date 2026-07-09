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
import { convertType, cvtColor, wrapPerspective, diff } from "core/Vision";
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

  // --- PIXEL PARITY (R-3 audit item 1): computable numeric ground truth ------
  // Drives the SAME `core/Vision` call sequence the capture worker embeds
  // (stack-average → convertType 16U → makeBGRA → wrapPerspective → diff →
  // downconvert 8U) on UNIFORM synthetic inputs, where the exact result is
  // known independently of any frame content: a uniform stack averages to its
  // value bit-exactly, an identity warp preserves uniformity, makeBGRA is
  // opaque, and the diff of two identical frames is exactly zero. This is the
  // math whose bytes must match the pre-wave `manual-control/capture.ts`.
  it("stacks/normalizes/diffs uniform frames to exact known values", () => {
    // makeMat: the @lib/mat shape/channels tag the worker uses verbatim.
    const makeMat = <T extends { shape?: number[]; channels?: number }>(
      arr: T,
      shape: number[],
      channels: number,
    ): T => ((arr.shape = shape), (arr.channels = channels), arr);
    // makeBGR/makeBGRA ported verbatim from the worker (mono branch).
    const makeBGR = (mat: any) => cvtColor(mat, "GRAY2BGR");
    const makeBGRA = (mat: any) => cvtColor(makeBGR(mat), "BGR2BGRA");

    const W = 16, H = 12, N = 5;
    const significantBits = 12; // 12p container → scale by 4095
    const alpha = 1 / ((1 << significantBits) - 1);
    const raw = 2048; // a mid-scale sensor value

    // (1) stack-average N IDENTICAL uniform frames — the exact averaging the
    // worker's `stackStream` does (accumulate convertType(raw,32F,alpha) then
    // /N). All frames equal ⇒ the average equals a single frame's value.
    let acc: any = null;
    for (let n = 0; n < N; n++) {
      const buf = new Uint16Array(W * H).fill(raw);
      const frame = makeMat(buf, [H, W], 1);
      const fp = convertType(frame as any, "32F", alpha, 0) as unknown as Float32Array;
      if (acc === null) acc = fp;
      else for (let i = 0; i < acc.length; i++) acc[i] += fp[i]!;
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= N;
    const expected = raw * alpha;
    for (let i = 0; i < acc.length; i++)
      expect(Math.abs(acc[i] - expected)).toBeLessThan(1e-6); // known exactly

    // (2) normalizeFovea(uniform, IDENTITY): convertType 16U → makeBGRA →
    // wrapPerspective(identity). A uniform input must yield a uniform, OPAQUE
    // BGRA output (identity warp is a no-op; makeBGRA sets alpha to max).
    const bgra16 = makeBGRA(convertType(acc, "16U"));
    const IDENTITY = makeMat(
      new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      [3, 3],
      1,
    );
    const wrapped = wrapPerspective(bgra16 as any, IDENTITY as any);
    // (3) downconvert to 8-bit BGRA (the getPreview / save-preview path).
    const bgra8 = convertType(wrapped as any, "8U") as unknown as Uint8Array;
    expect(bgra8.length).toBe(W * H * 4);
    const [b0, g0, r0, a0] = [bgra8[0]!, bgra8[1]!, bgra8[2]!, bgra8[3]!];
    expect(a0).toBe(255); // makeBGRA opaque
    for (let p = 0; p < W * H; p++) {
      // uniform in ⇒ uniform out (catches any stride / warp / demosaic drift)
      expect(bgra8[p * 4 + 0]).toBe(b0);
      expect(bgra8[p * 4 + 1]).toBe(g0);
      expect(bgra8[p * 4 + 2]).toBe(r0);
      expect(bgra8[p * 4 + 3]).toBe(255);
    }

    // (4) diff resource ground truth. `diff(l, r, true)` (Vision.cpp) is NOT an
    // absdiff — it builds a BGRA of [mono(a), 0, mono(b), max] with CLAHE
    // normalization (the `true` flag). For l === r the two mono channels are
    // therefore EQUAL (no red/blue color difference), green is black, alpha is
    // opaque, and every channel is spatially uniform (uniform input → uniform
    // output). This is the diff resource's computable ground truth.
    const d = diff(wrapped as any, wrapped as any, true) as unknown as ArrayLike<number>;
    expect(d.length).toBe(W * H * 4);
    const [dR0, dG0, dB0, dA0] = [d[0]!, d[1]!, d[2]!, d[3]!];
    expect(dG0).toBe(0); // green channel is always black
    expect(dR0).toBe(dB0); // identical inputs ⇒ no red/blue difference
    expect(dA0).toBe(65535); // 16-bit opaque alpha (rangeOf(U16).max)
    for (let p = 0; p < W * H; p++) {
      expect(d[p * 4 + 0]).toBe(dR0);
      expect(d[p * 4 + 1]).toBe(0);
      expect(d[p * 4 + 2]).toBe(dB0);
      expect(d[p * 4 + 3]).toBe(65535);
    }

    cleanup();
  });
});
