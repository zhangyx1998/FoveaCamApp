// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// capture-recorder-nodes Phase 1: session-owned RAW camera pipe. A gated
// `Frame::Ptr` subscriber on the camera's `Arv::Stream` (native
// `Aravis.attachRawPipe`) publishes FULL-BIT-DEPTH sensor bytes (`frame->raw`)
// as its own C-20 pipe — the enabler for the recorder/capture nodes, which need
// full depth (packed 12p arrives UNPACKED to a 16-bit container), NOT the 8-bit
// BGRA8 preview pipes.
//
// ON-DEMAND is the pipe consumer-gate contract: the native subscriber exists iff
// the pipe has a consumer (the recorder/capture node connects), so an idle raw
// pipe costs nothing on the capture thread. A recorder consumes it in FIFO mode
// (Phase 0 `readSeqInto`) with a DEEP ring — lossless up to the ring depth,
// drop-accounted past it, the writer never blocked.
//
// Seam-injected (never imports native core) — a later wave wires
// `Aravis.attachRawPipe`/`detachRawPipe` and gives a session a raw-pipe handle;
// this file is NOT wired into any session yet.

import type { PipeSpec } from "@lib/orchestrator/pipe-contract.js";

/** The camera the raw pipe subscribes to. Opaque to this wrapper (the native
 *  `Aravis.attachRawPipe` unwraps it) — kept `unknown` so the file stays
 *  core-free like the rest of `@orchestrator`. */
export type RawCamera = unknown;

export interface RawPipeSeam {
  advertise(spec: PipeSpec): number;
  unadvertise(pipeId: string): void;
  attach(camera: RawCamera, pipeId: string): void;
  detach(pipeId: string): void;
}

/** Sensor geometry for the raw pipe's ring — the camera's ACTUAL captured frame
 *  shape (learn it from one grabbed frame). `bytesPerElement` = the container
 *  width (1 for Mono8/Bayer8, 2 for Mono16 / 12p→16-bit). */
export interface RawPipeGeometry {
  width: number;
  height: number;
  /** Sensor channels (1 for mono/Bayer). Must match the frame mat exactly. */
  channels: number;
  bytesPerElement: number;
  /** The sensor format label (e.g. `"Mono12p"`) — carried through as the pipe's
   *  `pixelFormat` (opaque to the native byte copy; used for the topology row). */
  pixelFormat: string;
  /** Ring slot count — recorder territory (32–64) so a lagging FIFO consumer
   *  stays lossless up to the depth. Default 32. */
  ringDepth?: number;
}

export interface RawHandle {
  readonly pipeId: string;
  /** Detach the producer + un-advertise (consumers see CLOSED). */
  retire(): void;
}

/** Advertise the full-bit-depth raw pipe + attach the native producer on the
 *  camera source. Advertise BEFORE attach (attach looks up the pipe spec). */
export function createRawPipe(
  seam: RawPipeSeam,
  camera: RawCamera,
  pipeId: string,
  geom: RawPipeGeometry,
): RawHandle {
  const { width, height, channels, bytesPerElement, pixelFormat } = geom;
  const stride = width * channels * bytesPerElement;
  const bytesPerFrame = stride * height;
  seam.advertise({
    id: pipeId,
    pixelFormat,
    dtype: bytesPerElement > 1 ? "U16" : "U8",
    width,
    height,
    channels,
    stride,
    bytesPerFrame,
    ringDepth: geom.ringDepth ?? 32,
  });
  seam.attach(camera, pipeId);
  return {
    pipeId,
    retire: () => {
      seam.detach(pipeId);
      seam.unadvertise(pipeId);
    },
  };
}
