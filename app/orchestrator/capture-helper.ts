// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Composable CAPTURE facility (capture-recorder-everywhere ruling 3).
//
// Capture was reachable only from manual-control: the createCaptureNode wiring,
// the ON-DEMAND per-shot raw L/R advertise+connect (center rides the session's
// already-connected undistort pipe), the captureBusy/capture_meta telemetry, the
// captureShot/getPreview/save/discard command surface, AND the recording-vs-
// capture exclusivity guard all lived inline in manual-control/session.ts
// (5c7c9d4 state). This helper lifts that machinery ONCE so any triple-holding
// session opts in with CONFIG (its held L/R cameras, its live center pipe, an
// app-specific per-shot snapshot, and its recording service's `active` flag).
//
// The extraction is FAITHFUL to manual-control: same on-demand acquire sequence
// with the reverse-order error unwind (a mid-sequence throw never orphans a
// refcount → camera-exclusivity hazard), the same F1 burst-timeout semantics
// (owned by the capture NODE — the helper just forwards `snapshot()`'s optional
// `burstTimeoutMs`), and the same exclusivity refusal (capture refused while a
// recording holds the shared `camera/<serial>/raw` ids). manual-control becomes
// a consumer with its existing triple snapshot; behavior is pinned unchanged.
//
// Naming (planner ruling): the CONTRACT MIXIN names are `captureShot` /
// `getCapturePreview` / `saveCapture` / `discardCapture` (+ `captureBusy` /
// `capture_meta` telemetry) — collision-free with app-local commands (calibrate-
// intrinsic already has a `capture`). manual-control's contract keeps its legacy
// `capture`/`getPreview` names aliased to this same helper for backward compat.

import {
  createCaptureNode,
  type CaptureNodeHandle,
  type CaptureNodeOptions,
  type CaptureShot,
  type CaptureStreamInit,
} from "@orchestrator/capture-node";
import type { PipeBroker } from "@orchestrator/pipe-session";
import {
  rawPipeSpec,
  type RawPipeRegistry,
  type RawPipeAcquisition,
  type RawGeometrySource,
} from "@orchestrator/raw-pipe";
import { significantBits } from "@lib/util/dtype";
import type { PixelFormat } from "core/Aravis";
import type { FramePayload, Serializable } from "@lib/orchestrator/protocol";

/** A held center pipe the capture worker one-shot reads (the session's already-
 *  connected undistort/convert pipe — 8-bit BGRA, latest-wins). null until the
 *  session's activation has connected it. */
export interface CaptureCenterPipe {
  shmName: string;
  maxBytes: number;
  channels: number;
}

/** The two raw camera leases capture stacks (L/R). Matches the lease camera
 *  object (satisfies both the raw geometry spec and the native attach handle). */
export interface CaptureLeases {
  left: RawGeometrySource;
  right: RawGeometrySource;
}

/** A short capture-burst ring depth (manual-control used 8 for the on-demand
 *  per-shot advertise). */
const CAPTURE_RING_DEPTH = 8;

export interface CaptureHelperDeps {
  /** Graph node id — `capture/<session>` (compose via `nodeId.win`). */
  id: string;
  /** Broker for the on-demand per-shot raw L/R connects. */
  broker: PipeBroker;
  /** Refcounted raw-pipe registry (shared process-wide with recording). */
  rawPipes: RawPipeRegistry;
  /** Stable graph input pipe ids (wiring only — the actual raw connect is
   *  per-shot). `center` is the session's undistort/convert pipe id. */
  graphInputs: { left: string; right: string; center: string };
  /** The two raw camera leases (L/R), or null when the session is not active. */
  cameras(): CaptureLeases | null;
  /** The session's already-connected center pipe (undistort/convert), or null
   *  when not connected. Keeps the producer live for the one-shot read. */
  centerPipe(): CaptureCenterPipe | null;
  /** App-specific per-shot snapshot: the calibration-derived transforms +
   *  per-resource metadata for the whole shot. Return null when the session is
   *  not ready to capture (→ the command rejects "Capture not ready"). */
  snapshot(reset: boolean, indexed: boolean): CaptureShot | null;
  /** Exclusivity (ruling 6): true while a recording is active. Capture is
   *  refused while true — capture and recording share the raw pipe ids. */
  recordingActive(): boolean;
  /** Publish the capture telemetry patch (session `s.telemetry`). */
  telemetry(patch: { captureBusy?: boolean; capture_meta?: Record<string, Serializable> }): void;
  /** Test seam: capture node factory (default: the real one). */
  createNode?: (options: CaptureNodeOptions) => CaptureNodeHandle;
}

export interface CaptureHelper {
  /** True while a shot is in flight — the recording side reads this for the
   *  reciprocal exclusivity guard (`startRecording` refuses while capturing). */
  readonly capturing: boolean;
  /** The in-flight shot's promise (idle → resolved). Session teardown awaits
   *  this before tearing down the vision worker + pipes. */
  readonly activeCapture: Promise<void>;
  /** Build the (idle) capture node — call once on activate. */
  build(): void;
  /** Run ONE capture shot (the mixin `captureShot`). `tag` present ⇒ accumulate
   *  an indexed (raster) resource; absent/0 ⇒ fresh accumulation. Rejects when
   *  not ready or while a recording is active. */
  captureShot(tag?: number): Promise<void>;
  /** Pull one held resource downconverted to 8-bit BGRA (mixin
   *  `getCapturePreview`). */
  getPreview(resource: string, index?: number): Promise<FramePayload | null>;
  /** Persist the pending capture to disk and clear it (mixin `saveCapture`). */
  save(path: string, format: string): Promise<void>;
  /** Discard the pending capture (mixin `discardCapture`). */
  discard(): Promise<void>;
  /** Terminate the node's worker + retire its graph row (call on drain, AFTER
   *  `activeCapture` settles). */
  stop(): Promise<void>;
}

/** One connected raw stream → the worker's per-stream init (verbatim from
 *  manual-control's `streamInitFrom`). */
function streamInitFrom(conn: {
  shmName: string;
  spec: {
    pixelFormat: string;
    dtype: string;
    channels: number;
    bytesPerFrame: number;
    maxBytes?: number;
  };
}): CaptureStreamInit {
  return {
    shmName: conn.shmName,
    maxBytes: conn.spec.maxBytes ?? conn.spec.bytesPerFrame,
    channels: conn.spec.channels,
    bytesPerElement: conn.spec.dtype === "U16" ? 2 : 1,
    significantBits: significantBits(conn.spec.pixelFormat as PixelFormat),
    pixelFormat: conn.spec.pixelFormat,
  };
}

/** 3×3 identity (flat, row-major) — the degraded (no-wrap) fovea homography. */
const IDENTITY_H = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A degraded capture shot for a triple-holder that has no per-frame mirror
 *  pose to derive fovea homographies from (ruling 3: "capture degrades to raw
 *  stacks without the wrap"). The L/R foveae stack the raw sensors WITHOUT a
 *  perspective wrap (identity H — `wrapPerspective` is a no-op), the center is
 *  the FULL undistorted frame (an over-sized rect the worker clamps to the
 *  frame), and `capture_meta` states the degradation explicitly. Every triple-
 *  holder can produce this uniformly without coupling capture to its control
 *  loop's volt tracking. */
export function rawTripleShot(opts: {
  reset: boolean;
  indexed: boolean;
  stackCount: number;
  /** Human note for `capture_meta` (why the wrap is absent — e.g.
   *  "no undistort (extrinsic pre-calibration)" or "raw stacks, no pose"). */
  note?: string;
}): CaptureShot {
  const note = opts.note ?? "raw stacks (no per-frame mirror pose)";
  const modeMeta: Serializable = { capture: "raw-stack", wrap: "none", note };
  return {
    reset: opts.reset,
    indexed: opts.indexed,
    stackCount: opts.stackCount,
    H_L: [...IDENTITY_H],
    H_R: [...IDENTITY_H],
    // Over-sized rect → the worker's `clampRect` clamps it to the actual center
    // frame, yielding the full frame without main knowing its dims.
    rect: { x: 0, y: 0, width: 1e9, height: 1e9 },
    meta: {
      wide: opts.reset ? modeMeta : undefined,
      fovea: modeMeta,
      left: modeMeta,
      right: modeMeta,
    },
  };
}

export function createCaptureHelper(deps: CaptureHelperDeps): CaptureHelper {
  let node: CaptureNodeHandle | null = null;
  let activeCapture: Promise<void> = Promise.resolve();
  let capturing = false;
  const createNode = deps.createNode ?? createCaptureNode;

  /** ON-DEMAND per-shot connect (capture-node `AcquireStreams`) — extracted
   *  verbatim from manual-control's `acquireCaptureStreams`: advertise+attach
   *  the raw L/R producers (refcounted), connect all three streams, and return
   *  a `release` that disconnects then releases them. A throw mid-sequence
   *  unwinds what already succeeded in REVERSE order (else the orphaned
   *  refcount/connection never unadvertises — camera-exclusivity hazard). */
  function acquireCaptureStreams() {
    const cams = deps.cameras();
    const center = deps.centerPipe();
    if (!cams || !center) throw new Error("capture: session not active");
    const { left, right } = cams;
    let rawL: RawPipeAcquisition | null = null;
    let rawR: RawPipeAcquisition | null = null;
    let lConnected = false;
    let rConnected = false;
    try {
      const aL = deps.rawPipes.acquire({
        kind: "raw",
        camera: left,
        pipeId: `camera/${left.serial}/raw`,
        spec: rawPipeSpec(left, `camera/${left.serial}/raw`, CAPTURE_RING_DEPTH),
      });
      rawL = aL;
      const aR = deps.rawPipes.acquire({
        kind: "raw",
        camera: right,
        pipeId: `camera/${right.serial}/raw`,
        spec: rawPipeSpec(right, `camera/${right.serial}/raw`, CAPTURE_RING_DEPTH),
      });
      rawR = aR;
      const cL = deps.broker.connect(aL.pipeId);
      lConnected = true;
      const cR = deps.broker.connect(aR.pipeId);
      rConnected = true;
      return {
        streams: {
          left: streamInitFrom(cL),
          right: streamInitFrom(cR),
          center: {
            shmName: center.shmName,
            maxBytes: center.maxBytes,
            channels: center.channels,
          },
        },
        release: () => {
          deps.broker.disconnect(aL.pipeId);
          deps.broker.disconnect(aR.pipeId);
          aL.release();
          aR.release();
        },
      };
    } catch (err) {
      if (rConnected && rawR) deps.broker.disconnect(rawR.pipeId);
      if (lConnected && rawL) deps.broker.disconnect(rawL.pipeId);
      rawR?.release();
      rawL?.release();
      throw err;
    }
  }

  return {
    get capturing() {
      return capturing;
    },
    get activeCapture() {
      return activeCapture;
    },

    build() {
      node = createNode({
        id: deps.id,
        graphInputs: deps.graphInputs,
        acquireStreams: acquireCaptureStreams,
      });
    },

    async captureShot(tag?: number): Promise<void> {
      if (!node) throw new Error("Capture not ready");
      // EXCLUSIVITY (ruling 6): capture and recording advertise the SAME
      // `camera/<serial>/raw` ids; capture's per-shot advertise/retire would
      // clobber an active recording's pipes. Refuse cleanly (typed error →
      // renderer). Single-threaded, so the flag read is race-free.
      if (deps.recordingActive())
        throw new Error("Cannot capture while a recording is active");
      // `tag` absent OR 0 starts a fresh accumulation; a present tag accumulates
      // an indexed resource (raster).
      const reset = tag === undefined || tag === 0;
      const indexed = tag !== undefined;
      const shot = deps.snapshot(reset, indexed);
      if (!shot) throw new Error("Capture not ready");
      capturing = true;
      deps.telemetry({ captureBusy: true });
      activeCapture = node
        .capture(shot)
        .then((manifest) => {
          deps.telemetry({ capture_meta: manifest });
        })
        .finally(() => {
          capturing = false;
          deps.telemetry({ captureBusy: false });
        });
      await activeCapture;
    },

    async getPreview(resource: string, index?: number): Promise<FramePayload | null> {
      return node ? node.getPreview(resource, index) : null;
    },

    async save(path: string, format: string): Promise<void> {
      await node?.save(path, format);
      deps.telemetry({ capture_meta: {} });
    },

    async discard(): Promise<void> {
      await node?.discard();
      deps.telemetry({ capture_meta: {} });
    },

    async stop(): Promise<void> {
      await node?.stop();
      node = null;
    },
  };
}
