// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 pipe contract (C-16). The orchestrator ADVERTISES typed SHM pipes; a
// renderer selects one by id, `connectPipe`s ONCE to get a `PipeHandle`, then
// reads pixels per-frame straight from the shared segment via the reader addon
// (`reader.readInto(handle, dest, lastSeq)`, dest reused — C-15). Nothing rides
// the Channel per-frame: `frames: []`, no per-frame descriptor. The publisher
// (a C++ thread, `core.Pipe`) owns the segment the JS registry loop used to
// write.
//
// `PipeSpec` IS the explicit frame typing C-P12 called for: `bytesPerFrame` /
// `dtype` / `pixelFormat` are declared up front, so raw/16-bit/packed pipes are
// sized and decoded correctly instead of inferred from shape. `pixelFormat` /
// `dtype` are the canonical values from the single schema (B-owned) — imported
// read-only, never forked.
//
// Renderer- and orchestrator-safe, Vue-free — like every contract. Kept in its
// own file (not `contracts.ts`, not the pinned `viewer-contract.ts`); the
// planner arbitrates any later merge.

import { cmd, defineContract } from "./protocol.js";
import type { Dtype } from "../../../docs/schema/pixel-formats.js";

/** Static typing of one advertised pipe. Mirrors the C++ `Pipe::PipeSpec`.
 *  A `type` (not `interface`) so it satisfies the contract's `Serializable`
 *  state constraint — same pattern as `viewer-contract`'s `ViewerFile`. */
export type PipeSpec = {
  /** Stable pipe identifier the renderer selects by (e.g. `"preview:L"`). */
  id: string;
  /** Canonical sensor format name from `docs/schema/pixel-formats` (B-owned). */
  pixelFormat: string;
  /** Decoded container dtype (from the same schema). */
  dtype: Dtype;
  width: number;
  height: number;
  channels: number;
  /** Bytes per row of the decoded frame. */
  stride: number;
  /** Authoritative frame byte size — NOT inferred from shape (12p/U16 differ). */
  bytesPerFrame: number;
  /** Ring slot count for this pipe's segment (the seqlock depth). */
  ringDepth: number;
};

/** What `connectPipe` resolves to — everything a consumer needs to map + read
 *  the segment via the reader addon. `headerLayout` lets the consumer sanity-
 *  check the binary layout it's about to read (the addon also validates it
 *  natively on `open`). */
export type PipeHandle = {
  pipeId: string;
  /** POSIX segment name for `reader.open(shmName)`. */
  shmName: string;
  spec: PipeSpec;
  ringDepth: number;
  headerLayout: { layoutVersion: number; magic: string };
};

export const pipes = defineContract({
  state: {
    /** Every advertised pipe, in advertisement order. The renderer selects one
     *  by `id` and `connectPipe`s it. */
    pipes: [] as PipeSpec[],
  },
  telemetry: {},
  // No per-frame frame topics: once connected, pixels flow purely through the
  // shared segment (reader addon), never the Channel.
  frames: [] as const,
  commands: {
    /** One-time handshake: validates the id against the advertised specs,
     *  ensures the publisher (refcount++), and returns the `PipeHandle`. */
    connectPipe: cmd<{ pipeId: string }, PipeHandle>(),
    /** Release a consumer (refcount--). At zero the publisher pauses
     *  production, but the pipe stays advertised and is reconnectable. */
    disconnectPipe: cmd<{ pipeId: string }, void>(),
  },
});

export type PipesContract = typeof pipes;
