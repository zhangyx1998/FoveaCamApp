// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The MEMS controller thread node: one long-lived singleton ("controller") created
// at orchestrator startup, binding/unbinding the active serial Controller as the
// controller session connects/disconnects. Absorbs the actuation loop as a push
// model (openPosition inputs → MCU CMD_STREAM v2 / paced loop v1), owns the
// enable-iff-we-enabled lifecycle, and schedules round-robin trigger capture
// forwarding FINs to sink nodes. Native-free by construction (injected seams).
// spec: docs/spec/controller.md#controller-node

import type { Pos } from "@lib/controller-codec";
import type {
  Controller,
  FrameOutcome,
  NativeMirrorSinkHandle,
  StreamHandle,
} from "./controller.js";
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

/** Native position input: a session pipes a native volts producer (compose brick
 *  `volt_out`) into the sink's `pos_in`; needs a bound v2 controller (stream +
 *  sink created lazily, detached on unbind/close). Shares the JS-input
 *  enable/disable lifecycle.
 *  @remarks spec: docs/spec/controller.md#native-position-input */
export interface OpenNativePositionOptions {
  initial: PositionPair;
  /** Graph node id for the sink's incoming link edge (default "controller"). */
  nodeId?: string;
  /** A native sink is live — pipe into `sink.pos_in` now. */
  onAttach(sink: NativeMirrorSinkHandle["sink"]): void;
  /** The sink is going away (unbind/close) — release the link now. */
  onDetach(): void;
}

export interface NativePositionInput {
  /** The live native sink (null while no v2 controller is bound). */
  readonly sink: NativeMirrorSinkHandle["sink"] | null;
  /** The attached sink's MCU stream id (null until the lazy/async native
   *  attach lands) — the CMD_FRAME target for trigger-sync capture. */
  readonly streamId: number | null;
  /** Detach + TERMINATE + retire (disable iff we enabled and last one out). */
  close(): Promise<void>;
}

/** An injected FIN-outcome sink (no native imports): the anchor enrichment
 *  node registers one, and `startTriggerCapture` forwards every completed
 *  exposure to it (pairing-nodes ruling 6). */
export type FinSink = (outcome: FrameOutcome) => void;

export interface TriggerCaptureOptions {
  /** Round-robin CMD_FRAME targets (stream ids from the open position inputs). */
  targets: ScheduledFrameTarget[];
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

const V1_INTERVAL_MS = 1;

export class ControllerNode {
  private controller: Controller | null = null;
  private enabledByUs = false;

  // Position inputs, and the node-level "latest pose / last input" the v1 loop
  // actuates (single-input assumption — app exclusivity).
  private readonly inputs = new Set<PositionInputImpl>();
  // Native position inputs (native-compose-controller.md) — attach/detach with
  // the controller bind lifecycle; counted with `inputs` for disable-on-last.
  private readonly nativeInputs = new Set<NativePositionInputImpl>();
  private latestPose: PositionPair;
  private lastInput: PositionInputImpl | null = null;

  // v1 paced loop.
  private v1Running = false;

  // Trigger mode: FIN outcomes fan out to registered sinks (anchor enrichment).
  private readonly finListeners = new Set<FinSink>();

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
    // Native inputs attach lazily against the fresh controller (v2 only).
    for (const input of this.nativeInputs) input.sync();
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
    if (gone) {
      for (const input of this.inputs) await input.dropStream();
      // Native inputs detach (link released via onDetach, sink dropped;
      // TERMINATE is best-effort — the device may already be gone).
      for (const input of this.nativeInputs) await input.drop();
    }
  }

  get connected(): boolean {
    return !!this.controller?.connected;
  }

  // --- position inputs -------------------------------------------------------

  /** Open a NATIVE position input (native-compose-controller.md). The sink
   *  attaches asynchronously (needs a bound v2 controller — now or on a later
   *  bind); the session reacts via `onAttach`/`onDetach`. */
  openNativePosition(
    name: string,
    opts: OpenNativePositionOptions,
  ): NativePositionInput {
    const input = new NativePositionInputImpl(this, name, opts);
    this.nativeInputs.add(input);
    input.sync();
    return input;
  }

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

  /** Register a FIN-outcome sink (the anchor enrichment node). Every completed
   *  exposure from an active `startTriggerCapture` is forwarded here — the root
   *  PairStream (not this node) does the L/R matching now (pairing-nodes ruling
   *  6). Returns an unregister. */
  onFin(sink: FinSink): () => void {
    this.finListeners.add(sink);
    return () => this.finListeners.delete(sink);
  }

  /** Start round-robin CMD_FRAME capture; each FIN outcome is forwarded to the
   *  registered FIN sinks. Composes the pure `RoundRobinFrameScheduler`. */
  startTriggerCapture(opts: TriggerCaptureOptions): { stop(): void } {
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
      onFrame: (outcome) => this.emitFin(outcome),
    });
    scheduler.start();
    return { stop: () => scheduler.stop() };
  }

  private emitFin(outcome: FrameOutcome): void {
    for (const sink of this.finListeners) sink(outcome);
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
    if (this.inputs.size === 0 && this.nativeInputs.size === 0)
      await this.disableIfLast();
  }

  /** @internal — TRUE while any native input is attached OR attaching
   *  (value-sweep 2026-07-11 `dual-cmd-stream-handoff-race`): the JS inputs
   *  must not create/hold their own CMD_STREAM in that window — the firmware
   *  DAC is first-CREATE-wins and never re-arbitrates, so a second stream
   *  either parks the mirrors dead (native stream lost the race) or leaves
   *  an FW5-violating orphan (JS stream lost). `creating` is set
   *  SYNCHRONOUSLY in sync(), so the suppression is active from
   *  `openNativePosition()`'s return — before the fallback's first update. */
  nativeEngaged(): boolean {
    for (const n of this.nativeInputs) if (n.engagedOrPending) return true;
    return false;
  }

  /** @internal — the explicit fallback→native HANDOFF: TERMINATE any stream
   *  a JS input still holds (created before the native attach began, e.g.
   *  when the controller bound after activation). Called by the native input
   *  the moment its sink attaches, BEFORE the session pipes volts into it. */
  async handoffToNative(): Promise<void> {
    for (const input of this.inputs) await input.dropStream();
  }

  /** @internal — native-input retire: same disable-iff-last discipline. */
  async retireNativeInput(input: NativePositionInputImpl): Promise<void> {
    this.nativeInputs.delete(input);
    if (this.inputs.size === 0 && this.nativeInputs.size === 0)
      await this.disableIfLast();
  }

  private async disableIfLast(): Promise<void> {
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
          // Transient v1 failure (a dropped packet, a mid-swap actuate) —
          // retry next tick. Do NOT clear `enabledByUs` here (value-sweep
          // 2026-07-11 `v1-transient-error-clears-enabledByUs`): the device
          // stays enabled, and clearing the ownership flag silently broke
          // disable-on-last-close. The flag is cleared only where the enable
          // state actually changes: disableIfLast (we disabled) and
          // unbindController (the device is gone).
        }
        await new Promise((r) => setTimeout(r, V1_INTERVAL_MS));
      }
      this.v1Running = false;
    })();
  }

  /** Retire the node entirely (test/teardown). */
  dispose(): void {
    this.v1Running = false;
    this.finListeners.clear();
    this.unregisterWiring();
  }
}

/** Default control-edge type (no frame on the control path — scalars). */
const PID_STREAM: StreamType = { kind: "analysis", schema: "pid" };

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
      // value-sweep `dual-cmd-stream-handoff-race`: while a native input is
      // attached or attaching, this JS input must not create/hold its own
      // CMD_STREAM (see ControllerNode.nativeEngaged). Drop anything still
      // held from before the attach began; the native path owns the wire.
      if (this.node.nativeEngaged()) {
        if (this.stream) void this.dropStream();
        return predicted;
      }
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
        // The node may have unbound / swapped / closed — or a NATIVE input may
        // have engaged (dual-cmd-stream-handoff-race) — while awaiting.
        if (this.closed || this.node.liveController !== c || this.node.nativeEngaged()) {
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

/** The native position input (native-compose-controller.md) — see
 *  {@link OpenNativePositionOptions}. All async transitions reconcile against
 *  controller swaps mid-await (the PositionInputImpl.ensureStream idiom). */
class NativePositionInputImpl implements NativePositionInput {
  private handle: NativeMirrorSinkHandle | null = null;
  private creating = false;
  private closed = false;

  constructor(
    private readonly node: ControllerNode,
    readonly name: string,
    private readonly opts: OpenNativePositionOptions,
  ) {}

  get sink(): NativeMirrorSinkHandle["sink"] | null {
    return this.handle?.sink ?? null;
  }

  get streamId(): number | null {
    return this.handle?.streamId ?? null;
  }

  /** @internal — attached OR attach in flight (the JS-stream suppression
   *  window; see ControllerNode.nativeEngaged). */
  get engagedOrPending(): boolean {
    return !this.closed && (this.creating || this.handle !== null);
  }

  /** @internal — attach against the current controller if possible (open +
   *  bindController). v1 / unbound controllers simply never attach; the
   *  session's fallback path owns those. */
  sync(): void {
    const c = this.node.liveController;
    if (this.closed || this.handle || this.creating || !c || !c.v2Capable)
      return;
    this.creating = true;
    void (async () => {
      try {
        await this.node.ensureEnabled(c);
        const h = await c.createNativeMirrorSink(
          this.opts.initial,
          this.opts.nodeId ?? nodeId.controller(),
        );
        // The node may have unbound / swapped / closed while awaiting.
        if (this.closed || this.node.liveController !== c) {
          try {
            await h.close();
          } catch {
            // best-effort — the device may already be gone
          }
          return;
        }
        this.handle = h;
        // Explicit fallback→native HANDOFF (dual-cmd-stream-handoff-race):
        // TERMINATE any CMD_STREAM a JS input created before this attach —
        // BEFORE the session pipes volts in, so the firmware never holds two
        // live streams for the same DAC.
        await this.node.handoffToNative();
        try {
          this.opts.onAttach(h.sink);
        } catch {
          // a session attach fault must not wedge the node
        }
      } catch {
        // enable / create failed — a later bind retries via sync()
      } finally {
        this.creating = false;
      }
    })();
  }

  /** @internal — detach on unbind (sink released; TERMINATE best-effort). */
  async drop(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (!h) return;
    try {
      this.opts.onDetach();
    } catch {
      // session detach fault — keep tearing down
    }
    try {
      await h.close();
    } catch {
      // best-effort — the device may already be gone
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.drop();
    await this.node.retireNativeInput(this);
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
