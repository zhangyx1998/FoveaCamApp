// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MEMS controller THREAD NODE (docs/proposals/controller-node-and-fifo-
// edges.md §3). ONE long-lived singleton — the graph node id `nodeId.controller()`
// ("controller") — created at orchestrator startup. It binds/unbinds the active
// `Controller` (serial device) as the controller session connects/disconnects,
// so PID-node edges registered before the device connects stay stable.
//
// It ABSORBS `startActuationLoop` (actuation.ts) as a PUSH model:
//
//  - `openPosition(name, { from, initial })` → a position-stream input. Sessions
//    push a pose at their OWN natural cadence (kernel result / pointer / servo
//    tick / a paced timer); the node transports it to the device:
//      * v2 firmware — each input maps 1:1 to an MCU CMD_STREAM (created lazily
//        on first update against a live controller, `StreamUpdateGate`-gated
//        fire-and-forget updates, terminated on close, recreated on a controller
//        swap). Free-run DAC-follow is firmware-defined (CREATE drives).
//      * v1 firmware — ONE node-level paced loop awaits `actuate()` over the
//        most-recent pushed pose (single-input assumption holds via app
//        exclusivity today).
//    `update()` runs `predictVolts` + `mirrorHistory.record` (the ONE place for
//    the trusted-time trajectory) and returns the predicted volts SYNCHRONOUSLY
//    — sessions use the return for telemetry / homography feeders. Optional
//    `onApplied(volts, actuateMs)` delivers the v1 awaited readback.
//
//  - Enable lifecycle absorbed from the loop: enable on first update against a
//    live disabled controller (tracked `enabledByUs`), disable on last close IFF
//    we enabled it (never disable a controller the user enabled via the title
//    bar). A reconnect drops the streams and lazily recreates them; it NEVER
//    calls disable on a vanished/​swapped controller — the hardware-quiescence
//    invariant (disable-on-disconnect in sessions/controller.ts + the janitor)
//    is the sole owner of that path, and this node must not bypass it.
//
//  - `bindFoveaCameras` + `startTriggerCapture` + `onPair` compose the pure,
//    tested `RoundRobinFrameScheduler` (scheduler.ts) with `matchPair` (sync.ts)
//    for trigger-mode fovea PAIR matching: FIN outcomes matched against per-side
//    descriptor rings by trusted host-ns exposure time. Pairs carry frame
//    DESCRIPTORS + FIN volt/timestamps (pixel payloads keep riding the existing
//    pipes); the live Aravis frame-tap + recorder consumption are stage-F.
//
// NATIVE-FREE by construction: it takes injected `FrameTap` descriptor seams and
// type-only `Controller`/`FrameOutcome` imports, so sessions and vitest never
// pull the addon (same idiom as UndistortPipeSeam / the scheduler's requester).

import type { Pos } from "@lib/controller-codec";
import type { Controller, FrameOutcome, StreamHandle } from "./controller.js";
import type { StreamType } from "@lib/orchestrator/graph-contract.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import {
  registerGraphWiring,
  type GraphWiring,
  type WiredNode,
} from "./graph-topology.js";
import { mirrorHistory } from "./mirror-history.js";
import { hostNowNs } from "./time-align.js";
import {
  RoundRobinFrameScheduler,
  type FrameRequest,
  type FrameRequestPromise,
  type ScheduledFrameTarget,
} from "./scheduler.js";
import { matchPair, type ClockCalibration, type DeviceTimestamped } from "./sync.js";

/** A commanded mirror pose (both eyes) — the position-stream payload. */
export interface PositionPair {
  left: Pos;
  right: Pos;
}

export interface OpenPositionOptions {
  /** Producer node id for the graph edge `from → controller` (port = the input
   *  `name`). Omit when the producer already draws its own `…→controller`
   *  edges (e.g. the marker servo's per-eye PID nodes) — no edge is registered. */
  from?: string;
  /** Initial pose — the stream CREATE target (v2) / the seed the v1 loop holds
   *  until the first update, and the value `update()` echoes before a controller
   *  is bound. */
  initial: PositionPair;
  /** Stream type of the registered edge (default analysis/"pid"). */
  type?: StreamType;
  /** v1 awaited path only: the actuate readback + round-trip ms, per tick. On
   *  v2 (streaming) there is no round-trip, so this never fires and the caller
   *  uses `update()`'s synchronous return with a ~0 actuateMs. */
  onApplied?(volts: { L: Pos; R: Pos }, actuateMs: number): void;
}

export interface PositionInput {
  /** Push a target pose. Records `predictVolts` into the mirror-history
   *  trajectory (ONE place) and returns the predicted volts synchronously; the
   *  MCU stream (v2) / paced loop (v1) applies it. When no controller is bound
   *  the last predicted value is returned (the mirror holds) and nothing is
   *  recorded — matching the old loop's idle (`onVolts` never fired). */
  update(pos: PositionPair): PositionPair;
  /** Terminate the MCU stream, retire the graph edge, and — if this was the
   *  last open input and the node enabled the controller — disable it. */
  close(): Promise<void>;
}

/** One recent camera-frame descriptor for trigger-mode pair matching — INJECTED
 *  (never a native Frame): trusted host-ns capture time + optional seq. */
export interface FrameDescriptor extends DeviceTimestamped {
  readonly deviceTimestamp: bigint;
  readonly seq?: number;
}

/** An injected per-side camera descriptor seam (no native imports): the source
 *  node id + a subscribe returning an unsubscribe. */
export interface FrameTap {
  nodeId: string;
  subscribe(cb: (desc: FrameDescriptor) => void): () => void;
}

/** A trigger-matched fovea pair — the node's `fovea-pair` OUTPUT record. Carries
 *  the FIN outcome (volts + trusted timestamps) and the matched L/R DESCRIPTORS
 *  (pixels keep riding the existing pipes this wave). */
export interface FoveaPair {
  outcome: FrameOutcome;
  left: FrameDescriptor;
  right: FrameDescriptor;
  stream: number;
}

export interface TriggerCaptureOptions {
  /** Round-robin CMD_FRAME targets (stream ids from the open position inputs). */
  targets: ScheduledFrameTarget[];
  /** Match window: `|tExposure − deviceTimestamp| ≤ tolerance`, both trusted
   *  host-ns. RULED default (§3) = half the minimum frame interval; pass either
   *  `toleranceNs` directly or `minFrameIntervalNs` (halved). */
  toleranceNs?: bigint;
  minFrameIntervalNs?: bigint;
  /** Per-side residual delta (trigger-path latency) folded into the match;
   *  default zero (calibrated owners put both sides in host-ns already). */
  calibration?: ClockCalibration;
  /** Bounded per-side descriptor ring depth (default 32). */
  ringSize?: number;
  /** Scheduler pass-through knobs (pacing, timeouts). */
  scheduler?: Partial<
    Pick<
      import("./scheduler.js").FrameSchedulerOptions,
      | "maxInFlight"
      | "defaultMinIntervalMs"
      | "acceptedTimeoutMs"
      | "completionTimeoutMs"
    >
  >;
}

const DEFAULT_RING = 32;
const DEFAULT_TOLERANCE_NS = 8_000_000n; // 8 ms — rig-tuned at stage-F.
const V1_INTERVAL_MS = 1;

type Side = "left" | "right";

/** Bounded descriptor ring (newest-last, oldest evicted) — the per-side match
 *  window fed by the fovea taps. */
class DescriptorRing {
  private readonly items: FrameDescriptor[] = [];
  constructor(private readonly capacity: number) {}
  push(d: FrameDescriptor): void {
    this.items.push(d);
    if (this.items.length > this.capacity) this.items.shift();
  }
  get list(): readonly FrameDescriptor[] {
    return this.items;
  }
  clear(): void {
    this.items.length = 0;
  }
}

export class ControllerNode {
  private controller: Controller | null = null;
  private enabledByUs = false;

  // Position inputs, and the node-level "latest pose / last input" the v1 loop
  // actuates (single-input assumption — app exclusivity).
  private readonly inputs = new Set<PositionInputImpl>();
  private latestPose: PositionPair;
  private lastInput: PositionInputImpl | null = null;

  // v1 paced loop.
  private v1Running = false;

  // Trigger mode.
  private readonly rings = new Map<Side, DescriptorRing>();
  private readonly pairListeners = new Set<(pair: FoveaPair) => void>();
  private readonly foveaTaps: Array<() => void> = [];

  // Topology: ONE stable wiring registered at construction (stays first in the
  // registration Set, so its declared `controller` node wins over any
  // placeholder a PID/​position edge would otherwise synthesize). `statsKey` is
  // MUTATED IN PLACE on connect/disconnect — the fold reads it live each snapshot
  // — so the node keeps its position without a churny re-register.
  private readonly wiringNode: WiredNode = {
    id: nodeId.controller(),
    kind: "controller",
    output: null,
    transport: "native",
  };
  private readonly wiring: GraphWiring = { nodes: [this.wiringNode], edges: [] };
  private readonly unregisterWiring: () => void;

  constructor(initial: PositionPair = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } }) {
    this.latestPose = clonePair(initial);
    this.unregisterWiring = registerGraphWiring(this.wiring);
  }

  // --- controller binding (sessions/controller on connect/disconnect) --------

  /** Bind the freshly-connected serial device and fold its `controller:<port>`
   *  serial meter into the node's stats. Streams recreate lazily on the next
   *  update; the v1 loop (re)starts if inputs are open. */
  bindController(c: Controller): void {
    this.controller = c;
    this.wiringNode.statsKey = `controller:${c.port}`;
    if (this.inputs.size > 0 && !c.v2Capable) this.ensureV1Loop();
  }

  /** Unbind on disconnect: drop every MCU stream (best-effort — the device may
   *  be gone) and stop the v1 loop. NEVER disables — disable-on-disconnect lives
   *  in the session + janitor (hardware-quiescence invariant). */
  async unbindController(): Promise<void> {
    const gone = this.controller;
    this.controller = null;
    delete this.wiringNode.statsKey;
    this.enabledByUs = false;
    this.v1Running = false;
    if (gone) for (const input of this.inputs) await input.dropStream();
  }

  get connected(): boolean {
    return !!this.controller?.connected;
  }

  // --- position inputs -------------------------------------------------------

  openPosition(name: string, opts: OpenPositionOptions): PositionInput {
    const input = new PositionInputImpl(this, name, opts);
    this.inputs.add(input);
    this.latestPose = clonePair(opts.initial);
    this.lastInput = input;
    if (opts.from !== undefined)
      this.wiring.edges.push({
        from: opts.from,
        to: nodeId.controller(),
        port: name,
        type: opts.type ?? PID_STREAM,
      });
    const c = this.controller;
    if (c && !c.v2Capable) this.ensureV1Loop();
    return input;
  }

  // --- trigger mode ----------------------------------------------------------

  /** Bind the named L/R fovea camera descriptor taps (INJECTED seams). Each
   *  arriving descriptor lands in its side's bounded ring; a graph input
   *  `camera/<serial> → controller` (port `foveaL`/`foveaR`) is registered.
   *  Returns an unbind that drops the taps + edges + rings. */
  bindFoveaCameras(cams: { left?: FrameTap; right?: FrameTap }): () => void {
    const disposers: Array<() => void> = [];
    const bind = (side: Side, tap: FrameTap | undefined, port: string): void => {
      if (!tap) return;
      const ring = new DescriptorRing(DEFAULT_RING);
      this.rings.set(side, ring);
      const off = tap.subscribe((d) => ring.push(d));
      const edge = {
        from: tap.nodeId,
        to: nodeId.controller(),
        port,
        type: FRAME_STREAM,
      };
      this.wiring.edges.push(edge);
      disposers.push(() => {
        off();
        this.rings.delete(side);
        const i = this.wiring.edges.indexOf(edge);
        if (i >= 0) this.wiring.edges.splice(i, 1);
      });
    };
    bind("left", cams.left, "foveaL");
    bind("right", cams.right, "foveaR");
    const unbind = () => {
      for (const d of disposers) d();
    };
    this.foveaTaps.push(unbind);
    return unbind;
  }

  /** Start round-robin CMD_FRAME capture; matched L/R pairs emit on `onPair`.
   *  Composes the pure `RoundRobinFrameScheduler` + `matchPair`. */
  startTriggerCapture(opts: TriggerCaptureOptions): { stop(): void } {
    const tolerance =
      opts.toleranceNs ??
      (opts.minFrameIntervalNs !== undefined
        ? opts.minFrameIntervalNs / 2n
        : DEFAULT_TOLERANCE_NS);
    const calibration = opts.calibration ?? { left: 0n, right: 0n };
    if (opts.ringSize !== undefined)
      for (const side of ["left", "right"] as const)
        this.rings.set(side, new DescriptorRing(opts.ringSize));

    const requester = {
      frame: (request: FrameRequest): FrameRequestPromise => {
        const c = this.controller;
        if (!c) throw new Error("Controller not connected");
        return c.frame(request);
      },
    };
    const scheduler = new RoundRobinFrameScheduler({
      requester,
      targets: opts.targets,
      ...(opts.scheduler ?? {}),
      onFrame: (outcome) => this.matchAndEmit(outcome, calibration, tolerance),
    });
    scheduler.start();
    return { stop: () => scheduler.stop() };
  }

  onPair(cb: (pair: FoveaPair) => void): () => void {
    this.pairListeners.add(cb);
    return () => this.pairListeners.delete(cb);
  }

  private matchAndEmit(
    outcome: FrameOutcome,
    calibration: ClockCalibration,
    tolerance: bigint,
  ): void {
    const left = this.rings.get("left")?.list ?? [];
    const right = this.rings.get("right")?.list ?? [];
    const matched = matchPair(left, right, calibration, outcome, tolerance);
    if (!matched) return; // unmatched — dropped (aged out of the ring window)
    const pair: FoveaPair = {
      outcome,
      left: matched.left,
      right: matched.right,
      stream: outcome.stream,
    };
    for (const cb of this.pairListeners) cb(pair);
  }

  // --- internals shared with PositionInputImpl -------------------------------

  /** @internal */ get liveController(): Controller | null {
    return this.controller;
  }

  /** @internal — record the trusted-time trajectory ONCE per update. */
  recordTrajectory(predicted: PositionPair): void {
    mirrorHistory.record(hostNowNs(), predicted.left, predicted.right);
  }

  /** @internal — remember the freshest pose + which input drove it (v1 loop). */
  noteUpdate(input: PositionInputImpl, pose: PositionPair): void {
    this.latestPose = pose;
    this.lastInput = input;
  }

  /** @internal — enable the controller if we haven't and it isn't already. */
  async ensureEnabled(c: Controller): Promise<void> {
    if (!c.enabled) {
      await c.enable();
      this.enabledByUs = true;
    }
  }

  /** @internal — remove a drained input; disable iff we enabled + last one out. */
  async retireInput(input: PositionInputImpl): Promise<void> {
    this.inputs.delete(input);
    if (this.lastInput === input) this.lastInput = null;
    // Retire the input's graph edge.
    const idx = this.wiring.edges.findIndex(
      (e) => e.to === nodeId.controller() && e.port === input.name && e.from === input.from,
    );
    if (idx >= 0) this.wiring.edges.splice(idx, 1);
    if (this.inputs.size === 0) {
      this.v1Running = false;
      const c = this.controller;
      if (this.enabledByUs && c) {
        try {
          await c.disable();
        } catch {
          // best-effort — a dropped controller may already be gone
        } finally {
          this.enabledByUs = false;
        }
      }
    }
  }

  /** @internal — start the ONE v1 paced loop if a v1 controller + inputs exist. */
  ensureV1Loop(): void {
    if (this.v1Running) return;
    this.v1Running = true;
    void (async () => {
      while (this.v1Running) {
        const c = this.controller;
        if (!c || c.v2Capable || this.inputs.size === 0) break;
        try {
          await this.ensureEnabled(c);
          const t0 = performance.now();
          const { left, right } = await c.actuate(this.latestPose);
          this.lastInput?.opts.onApplied?.(
            { L: left, R: right },
            performance.now() - t0,
          );
        } catch {
          // controller dropped / not enabled — retry next tick
          this.enabledByUs = false;
        }
        await new Promise((r) => setTimeout(r, V1_INTERVAL_MS));
      }
      this.v1Running = false;
    })();
  }

  /** Retire the node entirely (test/teardown). */
  dispose(): void {
    this.v1Running = false;
    for (const off of this.foveaTaps) off();
    this.foveaTaps.length = 0;
    this.rings.clear();
    this.pairListeners.clear();
    this.unregisterWiring();
  }
}

/** Default control-edge type (no frame on the control path — scalars). */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };
/** Camera → controller (fovea trigger) edge type. */
const FRAME_STREAM: StreamType = { kind: "frame", pixelFormat: "sensor", dtype: "U8" };

class PositionInputImpl implements PositionInput {
  private stream: StreamHandle | null = null;
  private streamOwner: Controller | null = null;
  private creating = false;
  private closed = false;
  private lastPredicted: PositionPair;
  private latest: PositionPair;

  constructor(
    private readonly node: ControllerNode,
    readonly name: string,
    readonly opts: OpenPositionOptions,
  ) {
    this.lastPredicted = clonePair(opts.initial);
    this.latest = clonePair(opts.initial);
  }

  get from(): string | undefined {
    return this.opts.from;
  }

  update(pos: PositionPair): PositionPair {
    if (this.closed) return this.lastPredicted;
    this.latest = pos;
    this.node.noteUpdate(this, pos);

    const c = this.node.liveController;
    if (!c) return this.lastPredicted; // no device — mirror holds, nothing recorded

    const predicted = c.predictVolts({ left: pos.left, right: pos.right });
    this.lastPredicted = predicted;
    // ONE place for the trusted-time trajectory (unified-time §4).
    this.node.recordTrajectory(predicted);

    if (c.v2Capable) {
      // Keep `c.pos` live under streaming (no readback) so calibrate voltage
      // capture / drift derivation read the applied pose, as they did on the
      // pre-node awaited path (guarded — partial fakes may omit it).
      c.applyStreamedPos?.(predicted);
      if (this.streamOwner && this.streamOwner !== c) void this.dropStream();
      if (this.stream && this.streamOwner === c) this.stream.update(pos);
      else this.ensureStream(c);
    } else {
      this.node.ensureV1Loop();
    }
    return predicted;
  }

  /** Lazily CREATE the MCU stream (guarded against concurrent creates). */
  private ensureStream(c: Controller): void {
    if (this.creating) return;
    this.creating = true;
    void (async () => {
      try {
        await this.node.ensureEnabled(c);
        const s = await c.createStream(this.latest);
        // The node may have unbound / swapped / closed while awaiting — reconcile.
        if (this.closed || this.node.liveController !== c) {
          await safeClose(s);
          return;
        }
        this.stream = s;
        this.streamOwner = c;
      } catch {
        // enable / create failed — drop so the next good update retries
        this.stream = null;
        this.streamOwner = null;
      } finally {
        this.creating = false;
      }
    })();
  }

  /** @internal — TERMINATE the MCU stream (controller swap / disconnect). */
  async dropStream(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    this.streamOwner = null;
    if (s) await safeClose(s);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.dropStream();
    await this.node.retireInput(this);
  }
}

async function safeClose(s: StreamHandle): Promise<void> {
  try {
    await s.close();
  } catch {
    // best-effort TERMINATE — a dropped controller may already be gone
  }
}

function clonePair(p: PositionPair): PositionPair {
  return { left: { x: p.left.x, y: p.left.y }, right: { x: p.right.x, y: p.right.y } };
}

// --- module singleton (obtained like `activeController`) ---------------------
// ONE node per orchestrator process. `controllerNode()` lazily creates it (and
// registers its topology wiring); index.ts touches it at startup and
// sessions/controller.ts binds/unbinds the device on it.

let singleton: ControllerNode | null = null;

export function controllerNode(): ControllerNode {
  if (!singleton) singleton = new ControllerNode();
  return singleton;
}

/** Test hook: dispose + clear the singleton between cases. */
export function resetControllerNodeForTest(): void {
  singleton?.dispose();
  singleton = null;
}

/** A recursive-`setTimeout` pace loop (fake-timer friendly) for sessions that
 *  drive a position input at a fixed cadence — the push-model replacement for
 *  `startActuationLoop`'s internal 1 ms timer (the SESSION now owns the pacing;
 *  the node only transports). Returns a stop function. A throwing tick is
 *  swallowed so one bad frame can't kill the loop (matching the old loop's
 *  per-tick try/catch). */
export function startPacer(intervalMs: number, tick: () => void): () => void {
  let running = true;
  void (async () => {
    while (running) {
      try {
        tick();
      } catch {
        // a bad tick must not tear the pace loop down
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return () => {
    running = false;
  };
}
