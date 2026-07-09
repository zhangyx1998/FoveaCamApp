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
import type { Serializable } from "./protocol.js";
import type { StreamType } from "./graph-contract.js";
/** A pipe's container dtype — the graph contract's widened union (sensor
 *  dtypes + derived-pipe "F32"; see `ContainerDtype`). */
export type PipeDtype = import("./graph-contract.js").ContainerDtype;

/** Static typing of one advertised pipe. Mirrors the C++ `Pipe::PipeSpec`.
 *  A `type` (not `interface`) so it satisfies the contract's `Serializable`
 *  state constraint — same pattern as `viewer-contract`'s `ViewerFile`. */
export type PipeSpec = {
  /** Stable pipe identifier the renderer selects by (e.g. `"preview:L"`). */
  id: string;
  /** Canonical sensor format name from `docs/schema/pixel-formats` (B-owned),
   *  or a derived-pipe tag (e.g. `"Disparity32F"`). */
  pixelFormat: string;
  /** Container dtype (sensor schema dtypes + derived-pipe "F32"). */
  dtype: PipeDtype;
  width: number;
  height: number;
  channels: number;
  /** Bytes per row of the decoded frame. */
  stride: number;
  /** Authoritative frame byte size (NOMINAL/initial) — NOT inferred from shape. */
  bytesPerFrame: number;
  /** Ring slot count for this pipe's segment (the seqlock depth). */
  ringDepth: number;
  /** C-20 dynamic resize: the ring is sized to this MAX per-FOVEA footprint (a
   *  small hi-res crop, NOT the camera resolution — keeps N concurrent max rings
   *  bounded); each frame carries its own active w/h ≤ max. Omitted (== nominal)
   *  for fixed pipes like `camera:<serial>`. */
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
};

/** What `connectPipe` resolves to — everything a consumer needs to map + read
 *  the segment via the reader addon. `headerLayout` lets the consumer sanity-
 *  check the binary layout it's about to read (the addon also validates it
 *  natively on `open`). `epoch` is the segment generation (C-20 reuse-safe id). */
export type PipeHandle = {
  pipeId: string;
  /** POSIX segment name for `reader.open(shmName)`. */
  shmName: string;
  spec: PipeSpec;
  ringDepth: number;
  epoch: number;
  headerLayout: { layoutVersion: number; magic: string };
};

/** One advertised pipe in the discovery Record (C-20). `epoch` bumps each
 *  re-advertise of an id — the renderer detects a reused id and reconnects. */
export type PipeAdvert = {
  spec: PipeSpec;
  epoch: number;
};

/** One composed node in the discovery Record (C-24 step 3). `owner` is set for
 *  window-owned (`win/<windowId>/...`) nodes; camera-rooted composed bricks are
 *  shared (refcounted across windows) and carry no owner. */
export type NodeAdvert = {
  kind: string;
  output: StreamType | null;
  epoch: number;
  owner?: string;
};

/** Compose one node (C-24 two-mode, ruled): `id` must be EITHER under the
 *  calling window's `win/<windowId>/` namespace (exclusive, window-owned,
 *  torn down with the window) OR a legal camera-rooted brick path (shared,
 *  refcount semantics — idempotent across windows; refs→0 parks or tears
 *  down by brick kind). `inputs` maps the brick's named ports to upstream
 *  node ids. */
export type ComposeRequest = {
  id: string;
  kind: string;
  inputs: Record<string, string>;
  params?: Serializable;
};

export const pipes = defineContract({
  state: {
    /** Every advertised pipe, keyed by pipeId (C-20 dynamic discovery). Seeded
     *  to every subscriber (current set) + snapshot-replaced on each advertise/
     *  un-advertise (delta) — the renderer reacts to pipes appearing/vanishing
     *  at runtime by diffing this Record, like viewer's `files`. */
    pipes: {} as Record<string, PipeAdvert>,
    /** Every COMPOSED node, keyed by node id (C-24 step 3) — the same
     *  epoch-diff discovery discipline as `pipes`. */
    nodes: {} as Record<string, NodeAdvert>,
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
    /** Materialize a node (C-24 two-mode — see ComposeRequest). Idempotent per
     *  (window, id): a re-compose refs the existing node. */
    compose: cmd<ComposeRequest, NodeAdvert>(),
    /** Unref (camera-rooted) / tear down (win-rooted) a composed node. */
    decompose: cmd<{ id: string }, void>(),
  },
});

export type PipesContract = typeof pipes;
