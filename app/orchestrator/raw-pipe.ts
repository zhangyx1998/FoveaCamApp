// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// REFCOUNTED raw-pipe acquisition (multi-fovea-recording ruling 5). A single
// process-wide owner for the full-bit-depth `camera/<serial>/raw` (UNPACKED
// 16-bit container) and `camera/<serial>/raw12p` (PACKED verbatim wire) pipes:
//
//   - ONE advertise per pipe id EVER (kills the R-3 double-advertise class — a
//     second advertise of a live id would clobber the segment out from under an
//     already-connected consumer).
//   - Refcounted attach: the FIRST acquirer advertises + attaches the native
//     producer; later acquirers of the SAME id just bump the count and share it.
//   - Refcounted release: the LAST release detaches the producer + unadvertises.
//     Idle (no acquirers) = the id is fully retired and can be re-advertised
//     with fresh geometry on the next acquire.
//
// Both payload kinds are DISTINCT ids (`.../raw` vs `.../raw12p`), each owning
// its own refcount + native attach/detach fn (kind-routed through the seam).
// Multiple sessions (manual-control recording + capture; multi-fovea recording)
// share ONE registry so their independent capture-vs-recording policy guards
// STILL apply, but a clobber is now structurally impossible: two acquirers of a
// live id share the same segment instead of racing two advertises.
//
// Seam-injected (never imports native core): the native `Aravis.attachRawPipe`/
// `attachRaw12pPipe` (+ detach siblings) and the broker advertise/unadvertise
// are wired in `index.ts`; vitest drives a fake seam and never loads the addon.

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";
import { pixelFormatSpec } from "../../docs/schema/pixel-formats.js";

/** The camera the raw pipe subscribes to. Opaque to this wrapper (the native
 *  `Aravis.attach*Pipe` unwraps it) — kept `unknown` so the file stays
 *  core-free like the rest of `@orchestrator`. */
export type RawCamera = unknown;

/** Which native producer backs the pipe:
 *  - `"raw"`    — `attachRawPipe`: the UNPACKED 16-bit `frame->raw` container.
 *  - `"raw12p"` — `attachRaw12pPipe`: the VERBATIM packed wire payload (packed
 *    Bayer/Mono 12p when the sensor runs 12p readout, else whole-byte). */
export type RawPayloadKind = "raw" | "raw12p";

/** A raw pipe's advertise spec + the `significantBits` the native PipeSpec does
 *  NOT round-trip (C++ derives it internally from the format enum, so a codec-
 *  suffixed pixelFormat would lose it). The ADVERTISER carries it JS-side and
 *  injects it into the recorder connection (ruling 8: copied verbatim, never
 *  re-derived from the opaque pixelFormat). */
export type RawPipeAdvertSpec = PipeSpec & { significantBits: number };

/** The camera fields the geometry helpers read (a structural subset — kept core-
 *  free; the real lease camera satisfies it). */
export interface RawGeometrySource {
  serial: string;
  /** Canonical pixel-format name (`docs/schema/pixel-formats`). */
  pixel_format: string;
  getFeatureInt(name: string): number;
}

export interface RawPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  /** Attach the native producer for `kind` on `camera` → publish into `pipeId`.
   *  Advertise BEFORE attach (attach looks up the pipe spec). */
  attach(kind: RawPayloadKind, camera: RawCamera, pipeId: string): void;
  /** Detach the native producer for `kind` on `pipeId` (idempotent native-side). */
  detach(kind: RawPayloadKind, pipeId: string): void;
}

/** A single acquirer's grip on a shared raw pipe. `release()` decrements the
 *  shared refcount (idempotent per handle) and retires the pipe at zero. */
export interface RawPipeAcquisition {
  readonly pipeId: string;
  readonly kind: RawPayloadKind;
  /** The advertised spec (+ the JS-side `significantBits`, so the recorder
   *  connection can inject it verbatim). */
  readonly spec: RawPipeAdvertSpec;
  release(): void;
}

/** A pre-built pipe request (id + kind + spec). Build the spec with
 *  `rawPipeSpec` / `raw12pPipeSpec` (or hand a custom spec through). */
export interface RawPipeRequest {
  kind: RawPayloadKind;
  camera: RawCamera;
  pipeId: string;
  spec: RawPipeAdvertSpec;
}

export interface RawPipeRegistry {
  /** Acquire (advertise+attach on 0→1, share otherwise). The first acquirer's
   *  spec wins; later acquirers of a live id ignore their spec (ONE advertise
   *  ever). Acquiring a live id with a DIFFERENT kind throws (distinct ids). */
  acquire(req: RawPipeRequest): RawPipeAcquisition;
  /** Current refcount for a pipe id (0 when idle/retired). Test/telemetry hook. */
  refCount(pipeId: string): number;
  /** The live advertised spec for a pipe id (undefined when idle) — the recorder
   *  connect seam reads `significantBits` from here to inject it verbatim. */
  specOf(pipeId: string): RawPipeAdvertSpec | undefined;
}

interface Entry {
  kind: RawPayloadKind;
  spec: RawPipeAdvertSpec;
  refs: number;
}

/**
 * Create the process-wide raw-pipe registry over an injected seam. Shared by
 * every session so the refcount (hence the single advertise/attach) is global.
 */
export function createRawPipeRegistry(seam: RawPipeSeam): RawPipeRegistry {
  const entries = new Map<string, Entry>();

  function acquire(req: RawPipeRequest): RawPipeAcquisition {
    const { pipeId, kind } = req;
    let entry = entries.get(pipeId);
    if (entry) {
      if (entry.kind !== kind)
        throw new Error(
          `raw-pipe "${pipeId}" already acquired as "${entry.kind}", not "${kind}"`,
        );
      entry.refs += 1;
    } else {
      // 0→1: advertise (ONCE) then attach the native producer (consumer-gated —
      // parks with no downstream consumer, zero capture-thread cost while idle).
      seam.advertise(req.spec);
      seam.attach(kind, req.camera, pipeId);
      entry = { kind, spec: req.spec, refs: 1 };
      entries.set(pipeId, entry);
    }
    const active = entry;
    let released = false;
    return {
      pipeId,
      kind,
      spec: active.spec,
      release() {
        if (released) return; // idempotent per handle
        released = true;
        active.refs -= 1;
        if (active.refs > 0) return;
        // →0: retire fully (detach BEFORE unadvertise, mirroring create order in
        // reverse). The id is now free to re-advertise with fresh geometry.
        entries.delete(pipeId);
        seam.detach(kind, pipeId);
        seam.unadvertise(pipeId);
      },
    };
  }

  return {
    acquire,
    refCount: (pipeId) => entries.get(pipeId)?.refs ?? 0,
    specOf: (pipeId) => entries.get(pipeId)?.spec,
  };
}

// ============================================================================
// Geometry → PipeSpec builders (pure; shared by every session + unit-tested).
// ============================================================================

/** Ring slot count for recorder-territory raw pipes (a lagging FIFO consumer
 *  stays lossless up to the depth, then drop-accounted, the writer never
 *  blocked). Manual-control + multi-fovea both use 48. */
export const DEFAULT_RAW_RING_DEPTH = 48;

/** The UNPACKED `camera/<serial>/raw` spec: the sensor's decoded container
 *  (12p→16-bit unpack already happened at Frame construction), so a whole-byte
 *  format stays 1 byte/elem and a 12p/16 format is a U16 container. */
export function rawPipeSpec(
  camera: RawGeometrySource,
  pipeId = `camera/${camera.serial}/raw`,
  ringDepth = DEFAULT_RAW_RING_DEPTH,
): RawPipeAdvertSpec {
  const format = camera.pixel_format;
  const spec = pixelFormatSpec(format);
  const channels = spec?.channels ?? 1;
  // Frame construction unpacks 12p → a 16-bit container, so the raw (unpacked)
  // pipe is U16 for any 12p/16 format and U8 for whole-byte 8-bit formats.
  const dtype = spec?.dtype === "U16" ? "U16" : "U8";
  const bytesPerElement = dtype === "U16" ? 2 : 1;
  const width = camera.getFeatureInt("Width");
  const height = camera.getFeatureInt("Height");
  const stride = width * channels * bytesPerElement;
  const bytesPerFrame = stride * height;
  return {
    id: pipeId,
    pixelFormat: format,
    dtype,
    width,
    height,
    channels,
    stride,
    bytesPerFrame,
    significantBits: spec?.significantBits ?? (dtype === "U16" ? 16 : 8),
    ringDepth,
  };
}

/** The PACKED `camera/<serial>/raw12p` spec: the VERBATIM wire payload (ruling
 *  1 + `attachRaw12pPipe` d.ts). Advertise TRUE image `width`/`height` +
 *  `channels`=1 + `dtype`="U8" (opaque byte stream), `stride`=packed bytes/row,
 *  `significantBits` from the format (12 for 12p) so the viewer can unpack, and
 *  `maxBytes`/`bytesPerFrame` = the packed footprint. A whole-byte format packs
 *  to its own byte count (rig fake camera runs Mono8). */
export function raw12pPipeSpec(
  camera: RawGeometrySource,
  pipeId = `camera/${camera.serial}/raw12p`,
  ringDepth = DEFAULT_RAW_RING_DEPTH,
): RawPipeAdvertSpec {
  const format = camera.pixel_format;
  const spec = pixelFormatSpec(format);
  const width = camera.getFeatureInt("Width");
  const height = camera.getFeatureInt("Height");
  const significantBits = spec?.significantBits ?? 8;
  // Packed row bytes: 12p wire = 2 samples in 3 bytes (12 bits/sample); a whole-
  // byte format keeps its container bytes. `channels` is 1 in packed space
  // (Bayer/mono mosaics are single-channel; RGB packing is out of scope here).
  const channels = spec?.channels ?? 1;
  const stride = spec?.isPacked
    ? Math.ceil((width * channels * 12) / 8)
    : width * channels * (spec?.dtype === "U16" ? 2 : 1);
  const bytesPerFrame = stride * height;
  return {
    id: pipeId,
    // The packed wire format label (e.g. "BayerRG12p") — the viewer splits any
    // codec suffix off and unpacks by this base format.
    pixelFormat: format,
    dtype: "U8",
    width,
    height,
    channels,
    stride,
    bytesPerFrame,
    significantBits,
    // Active geometry the tap publishes is stride×height (a flat byte stream),
    // so the ring slot is bounded by the packed footprint.
    maxWidth: stride,
    maxHeight: height,
    maxBytes: bytesPerFrame,
    ringDepth,
  };
}
