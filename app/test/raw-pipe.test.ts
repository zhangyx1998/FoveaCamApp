// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Refcounted raw-pipe registry (multi-fovea-recording ruling 5). Proves the
// single-advertise invariant + refcounted attach/detach across BOTH payload
// kinds, and the packed/unpacked geometry the advertiser must populate.

import { describe, expect, it } from "vitest";
import {
  createRawPipeRegistry,
  rawPipeSpec,
  raw12pPipeSpec,
  type RawPayloadKind,
  type RawPipeSeam,
} from "@orchestrator/raw-pipe";

/** A fake seam that records every advertise/attach/detach/unadvertise call so
 *  the test can assert the ONE-advertise-per-id + refcounted-teardown contract. */
function fakeSeam() {
  const log: string[] = [];
  const advertised = new Set<string>();
  const attached = new Map<string, RawPayloadKind>();
  const seam: RawPipeSeam = {
    advertise(spec) {
      if (advertised.has(spec.id))
        throw new Error(`DOUBLE ADVERTISE of "${spec.id}" — refcount broken`);
      advertised.add(spec.id);
      log.push(`advertise:${spec.id}`);
      return 1;
    },
    unadvertise(pipeId) {
      advertised.delete(pipeId);
      log.push(`unadvertise:${pipeId}`);
    },
    attach(kind, _camera, pipeId) {
      attached.set(pipeId, kind);
      log.push(`attach:${kind}:${pipeId}`);
    },
    detach(kind, pipeId) {
      attached.delete(pipeId);
      log.push(`detach:${kind}:${pipeId}`);
    },
  };
  return { seam, log, advertised, attached };
}

const camera = (serial: string, format = "BayerRG12p", w = 640, h = 480) => ({
  serial,
  pixel_format: format,
  getFeatureInt: (name: string) => (name === "Width" ? w : name === "Height" ? h : 0),
});

describe("createRawPipeRegistry", () => {
  it("advertises + attaches ONCE, shares across acquirers, retires at zero", () => {
    const { seam, log, advertised } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("A");
    const id = "camera/A/raw12p";
    const spec = raw12pPipeSpec(cam, id);

    const a = reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec });
    expect(reg.refCount(id)).toBe(1);
    expect(advertised.has(id)).toBe(true);

    // Second acquirer of a LIVE id shares — NO second advertise/attach.
    const b = reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec });
    expect(reg.refCount(id)).toBe(2);
    expect(log.filter((l) => l.startsWith("advertise")).length).toBe(1);
    expect(log.filter((l) => l.startsWith("attach")).length).toBe(1);

    // First release decrements but keeps the pipe live.
    a.release();
    expect(reg.refCount(id)).toBe(1);
    expect(advertised.has(id)).toBe(true);
    expect(log).not.toContain(`detach:raw12p:${id}`);

    // Last release retires: detach BEFORE unadvertise.
    b.release();
    expect(reg.refCount(id)).toBe(0);
    expect(advertised.has(id)).toBe(false);
    expect(log.slice(-2)).toEqual([`detach:raw12p:${id}`, `unadvertise:${id}`]);
  });

  it("re-advertises after full release (idle id is free to re-acquire)", () => {
    const { seam, log } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("B");
    const id = "camera/B/raw";
    const spec = rawPipeSpec(cam, id);

    reg.acquire({ kind: "raw", camera: cam, pipeId: id, spec }).release();
    reg.acquire({ kind: "raw", camera: cam, pipeId: id, spec }).release();
    // Two full acquire/release cycles → two advertises (never a double-advertise
    // of a LIVE id, which the fake seam would have thrown on).
    expect(log.filter((l) => l === `advertise:${id}`).length).toBe(2);
    expect(log.filter((l) => l === `unadvertise:${id}`).length).toBe(2);
  });

  it("re-attaches the producer on re-acquire (retire→re-advertise restarts the gate, F1)", () => {
    // F1 capture-hang guard: manual-control capture (session.ts) and recording
    // (recording.ts) share `camera/<serial>/raw`. When a prior recording's LAST
    // release retires the producer (detach → unadvertise), a later capture
    // acquire of the SAME id is a fresh 0→1 edge that MUST re-advertise AND
    // re-attach — the attach re-runs `attachRawPipe` → `hub.setConsumerGate`, so
    // the C-21 producer gate is re-registered on the fresh epoch and the next
    // consumer connect can start frames flowing again. A registry that skipped
    // the re-attach would leave the reused id advertised but producer-gate-less
    // (readSeqInto → NotYet forever). This pins the ORDER too: advertise BEFORE
    // attach on every 0→1 (attach reads the just-advertised pipe spec).
    const { seam, log } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("B2");
    const id = "camera/B2/raw";
    const spec = rawPipeSpec(cam, id);

    // Recording: acquire (advertise+attach) then fully retire (detach+unadvertise).
    reg.acquire({ kind: "raw", camera: cam, pipeId: id, spec }).release();
    expect(reg.refCount(id)).toBe(0);
    expect(log).toEqual([
      `advertise:${id}`,
      `attach:raw:${id}`,
      `detach:raw:${id}`,
      `unadvertise:${id}`,
    ]);

    // Capture: fresh acquire of the retired id re-advertises AND re-attaches
    // (gate re-registered), in that order.
    const cap = reg.acquire({ kind: "raw", camera: cam, pipeId: id, spec });
    expect(reg.refCount(id)).toBe(1);
    expect(log.slice(-2)).toEqual([`advertise:${id}`, `attach:raw:${id}`]);
    expect(log.filter((l) => l === `attach:raw:${id}`).length).toBe(2);
    cap.release();
  });

  it("release is idempotent per handle (double release cannot over-decrement)", () => {
    const { seam } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("C");
    const id = "camera/C/raw12p";
    const spec = raw12pPipeSpec(cam, id);
    const a = reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec });
    const b = reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec });
    a.release();
    a.release(); // no-op — must NOT drop b's grip
    expect(reg.refCount(id)).toBe(1);
    b.release();
    expect(reg.refCount(id)).toBe(0);
  });

  it("keeps raw and raw12p as DISTINCT ids with independent refcounts", () => {
    const { seam, attached } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("D");
    const rawId = "camera/D/raw";
    const packedId = "camera/D/raw12p";
    const r = reg.acquire({ kind: "raw", camera: cam, pipeId: rawId, spec: rawPipeSpec(cam, rawId) });
    const p = reg.acquire({
      kind: "raw12p",
      camera: cam,
      pipeId: packedId,
      spec: raw12pPipeSpec(cam, packedId),
    });
    expect(attached.get(rawId)).toBe("raw");
    expect(attached.get(packedId)).toBe("raw12p");
    r.release();
    expect(reg.refCount(rawId)).toBe(0);
    expect(reg.refCount(packedId)).toBe(1);
    p.release();
  });

  it("throws if a live id is re-acquired with a different kind", () => {
    const { seam } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("E");
    const id = "camera/E/raw";
    reg.acquire({ kind: "raw", camera: cam, pipeId: id, spec: rawPipeSpec(cam, id) });
    expect(() =>
      reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec: raw12pPipeSpec(cam, id) }),
    ).toThrow(/already acquired as "raw"/);
  });

  it("specOf exposes the JS-side significantBits the native spec drops", () => {
    const { seam } = fakeSeam();
    const reg = createRawPipeRegistry(seam);
    const cam = camera("F", "BayerRG12p");
    const id = "camera/F/raw12p";
    const a = reg.acquire({ kind: "raw12p", camera: cam, pipeId: id, spec: raw12pPipeSpec(cam, id) });
    expect(reg.specOf(id)?.significantBits).toBe(12);
    a.release();
    expect(reg.specOf(id)).toBeUndefined();
  });
});

describe("raw12pPipeSpec (packed geometry)", () => {
  it("packs 12p as 2 samples per 3 bytes with U8 opaque byte stream", () => {
    const cam = camera("G", "BayerRG12p", 640, 480);
    const spec = raw12pPipeSpec(cam);
    expect(spec.dtype).toBe("U8");
    expect(spec.channels).toBe(1);
    expect(spec.significantBits).toBe(12);
    expect(spec.stride).toBe((640 * 12) / 8); // 960
    expect(spec.bytesPerFrame).toBe(960 * 480);
    expect(spec.maxBytes).toBe(960 * 480);
    expect(spec.pixelFormat).toBe("BayerRG12p");
    expect(spec.width).toBe(640);
    expect(spec.height).toBe(480);
  });

  it("packs a whole-byte format (Mono8) to its own byte count", () => {
    const cam = camera("H", "Mono8", 512, 512);
    const spec = raw12pPipeSpec(cam);
    expect(spec.stride).toBe(512);
    expect(spec.bytesPerFrame).toBe(512 * 512);
    expect(spec.significantBits).toBe(8);
  });
});

describe("compressPipeSpec (/zlib sibling advert)", () => {
  it("keeps the SOURCE active dims, suffixes the format, grows only the slot", async () => {
    const { compressPipeSpec, zlibBound } = await import("@orchestrator/compress-pipe");
    const src = raw12pPipeSpec(camera("Z", "BayerRG12p", 640, 480));
    const out = compressPipeSpec(src);
    expect(out.id).toBe("camera/Z/raw12p/zlib");
    expect(out.pixelFormat).toBe("BayerRG12p/zlib");
    expect(out.significantBits).toBe(12);
    // The brick forwards the source frame's identity per blob (core test 32):
    // the output ring must admit the source's max ACTIVE dims — only maxBytes
    // grows to the zlib worst case (regression: maxHeight=1 rejected every
    // offer() and the stream recorded zero frames).
    expect(out.maxWidth).toBe(src.maxWidth ?? src.stride);
    expect(out.maxHeight).toBe(src.maxHeight ?? src.height);
    expect(out.maxBytes).toBe(zlibBound(Math.max(src.maxBytes ?? 0, src.bytesPerFrame)));
    expect(out.maxBytes!).toBeGreaterThan(src.bytesPerFrame);
  });
});

describe("rawPipeSpec (unpacked container geometry)", () => {
  it("unpacks a 12p format to a U16 container", () => {
    const cam = camera("I", "BayerRG12p", 640, 480);
    const spec = rawPipeSpec(cam);
    expect(spec.dtype).toBe("U16");
    expect(spec.stride).toBe(640 * 2);
    expect(spec.bytesPerFrame).toBe(640 * 2 * 480);
    expect(spec.significantBits).toBe(12);
  });

  it("keeps a whole-byte format as a U8 container", () => {
    const cam = camera("J", "BayerRG8", 512, 512);
    const spec = rawPipeSpec(cam);
    expect(spec.dtype).toBe("U8");
    expect(spec.stride).toBe(512);
    expect(spec.significantBits).toBe(8);
  });
});
