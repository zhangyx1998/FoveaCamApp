// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side MEMS mirror controller. A non-Vue port of the device logic
// in the renderer `Controller.vue` (state is plain fields; the session reads and
// broadcasts it). Owns the serial `Device`; reuses the shared DAC math.

import { createMirrorSink, Protocol, Device, type LogLevel } from "core/Controller";
import type { CameraName, FrameArg, MirrorSink } from "core/Controller";
import { SerialPort } from "serialport";
import {
  channels,
  dac2volt,
  origin,
  volt2dac,
  type Pos,
} from "@lib/controller-codec";
import { registerWorkload, type WorkloadHandle } from "./metering.js";

type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

// Streams::CAPACITY, firmware/include/Streams.h — fixed-size table on the MCU.
export const STREAM_CAPACITY = 64;
export const STREAM_MIN_UPDATE_INTERVAL_MS = 1;

function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

function clonePos(pos: Pos): Pos {
  return { x: pos.x, y: pos.y };
}

/** Decode a 4-channel DAC vector — either an `actuate()` ACK readback or a
 *  locally-computed `channels()` array — into an {x,y} volt pair (the
 *  differential pairs 0-1 / 2-3 via `dac2volt`). Shared by `actuate()`'s
 *  readback decode and `predictVolts()` so the streamed local prediction is
 *  byte-for-byte the same math as the awaited readback (A-30). */
function decodeChannels(chan: readonly number[]): Pos {
  return { x: dac2volt(chan[0] - chan[1]), y: dac2volt(chan[2] - chan[3]) };
}

export class StreamIdPool {
  private readonly inUse = new Set<number>();

  constructor(readonly capacity = STREAM_CAPACITY) {}

  allocate(): number {
    for (let candidate = 0; candidate < this.capacity; candidate++) {
      if (!this.inUse.has(candidate)) {
        this.inUse.add(candidate);
        return candidate;
      }
    }
    throw new Error(`Stream capacity (${this.capacity}) exceeded`);
  }

  release(id: number): void {
    this.inUse.delete(id);
  }
}

export class StreamUpdateGate {
  private lastLeft: Pos;
  private lastRight: Pos;
  private lastSentAt: number;

  constructor(
    initial: { left: Pos; right: Pos },
    private readonly minIntervalMs = STREAM_MIN_UPDATE_INTERVAL_MS,
    now = performance.now(),
  ) {
    this.lastLeft = clonePos(initial.left);
    this.lastRight = clonePos(initial.right);
    this.lastSentAt = now;
  }

  accept(next: { left: Pos; right: Pos }, now = performance.now()): boolean {
    if (samePos(next.left, this.lastLeft) && samePos(next.right, this.lastRight))
      return false;
    if (now - this.lastSentAt < this.minIntervalMs) return false;
    this.lastLeft = clonePos(next.left);
    this.lastRight = clonePos(next.right);
    this.lastSentAt = now;
    return true;
  }
}

/** A CMD_STREAM handle (docs/history/refactor/synced-capture.md §3.2/§6): a named,
 *  continuously-updatable mirror-position target. `update()` is fire-and-
 *  forget (seq=0, ~1kHz-safe) — it never resolves/rejects, matching the
 *  protocol's design (the firmware sends no response for it at all). */
export interface StreamHandle {
  readonly id: number;
  update(pos: { left: Pos; right: Pos }): void;
  close(): Promise<void>;
}

/** A native mirror sink bound to a live MCU stream (native-compose-
 *  controller.md): `sink` exposes `pos_in` + the native history queries;
 *  `close()` releases the sink then TERMINATEs the stream (idempotent). */
export interface NativeMirrorSinkHandle {
  readonly sink: MirrorSink;
  close(): Promise<void>;
}

/** `Controller.frame()`'s decoded result — DAC channels converted to volts,
 *  matching `actuate()`'s existing convention. Distinct from core's raw
 *  `FrameResult` (`core/Controller`), which is in wire units. */
export interface FrameOutcome {
  /** Stable per-capture frame identity (FIN `frame_id`, B-12) — binds this
   *  outcome to the exact camera frame it produced, for downstream recorder
   *  metadata (WS4 4b). */
  frameId: number;
  stream: number;
  /** OWNER-APPLIED TRUSTED TIME (unified-time ruling 0): host-steady-domain
   *  NANOSECONDS — the raw MCU µs ×1000 plus the controller's calibrated dt
   *  (0 until `setClockOffsetNs`, i.e. raw µs-resolution ns). Downstream
   *  nodes NEVER re-correct these. */
  tTrigger: bigint;
  tExposure: bigint;
  /** Exposure-AVERAGED mirror voltage for this frame (B-12: MEMS voltage
   *  sampled at exposure start AND finish, then averaged), converted DAC→volts
   *  like `actuate()`. */
  left: Pos;
  right: Pos;
}

export class Controller {
  /** First serial port whose fields all match `match` (e.g. vendor/product id). */
  static async match(match: Partial<PortInfo>): Promise<PortInfo | undefined> {
    search: for (const info of await SerialPort.list()) {
      for (const [k, v] of Object.entries(match))
        if (info[k as keyof PortInfo] !== v) continue search;
      return info;
    }
  }

  private readonly device: Device;
  readonly ready: Promise<void>;
  /** Serial port path (e.g. `/dev/tty…`) — the identity behind this device's
   *  `controller:<port>` serial meter. The controller NODE folds that meter
   *  into its stats by this key on bind. */
  readonly port: string;
  private bias = 0;
  // Owner-applied dt (unified-time ruling 0): host-steady-ns offset mapping
  // the MCU µs clock into the trusted domain. 0 until calibration (the ping
  // on connect); atomically swapped on mid-task re-calibration — outcomes
  // decoded after the swap carry the new offset.
  private clockOffsetNs = 0n;
  /** Install the calibrated MCU→host offset (from `pingControllerOffset`).
   *  Every FIN timestamp surfaced after this call is trusted host-ns. */
  setClockOffsetNs(offsetNs: bigint): void {
    this.clockOffsetNs = offsetNs;
  }
  private _enabled = false;
  private _pos: { left: Pos; right: Pos } = origin;
  private readonly streamIds = new StreamIdPool();
  // Live-stream telemetry (docs/history/refactor/orchestrator.md §7.1 S4 added
  // scope): `count` accumulates between `streamSnapshot()` calls, which
  // reset it — the caller's sampling interval turns the raw count into a
  // rolling Hz. `left`/`right` are the last-sent target, for the
  // profiler's per-stream XY position pad.
  private readonly streamStats = new Map<
    number,
    { count: number; left: Pos; right: Pos }
  >();
  /** Observe-only serial WRITE meter (A-29). One `packets` output is emitted on
   *  every packet pushed to the wire — the awaited `set`/`actuate`/stream
   *  create+terminate + `frame` paths AND the fire-and-forget stream `update`
   *  hot path — so the serial send rate becomes a first-class
   *  `perfSnapshot.workloads` row (`controller:<port>`) the A-26 profiler sorts
   *  and flags. It was previously invisible (only `loopLag` hinted at the
   *  ~40 Hz cap). The `actuate()` round-trip is also timed as busy. NEVER gates:
   *  `emit`/`measure` are safe no-ops post-dispose and always run the wrapped
   *  send unchanged (the metering "observe, never gate" contract). */
  private readonly serialMeter: WorkloadHandle;

  constructor(
    info: PortInfo,
    readonly dv: number = 170.0,
    bias: number = 90.0,
    lpf: number = 120,
    log_level: LogLevel = "INFO",
  ) {
    this.port = info.path;
    this.serialMeter = registerWorkload(`controller:${info.path}`, {
      inputs: [],
      outputs: ["packets"],
    });
    this.device = new Device(info.path);
    const device = this.device;
    this.ready = (async () => {
      // Must run before anything two-phase-sensitive (createStream/frame,
      // and actuate/trigger's `.accepted`) — see P3.1a,
      // docs/history/refactor/synced-capture.md §9.3. Never throws on a version
      // *mismatch* (only on a transport failure): old firmware just keeps
      // device.v2Capable false (v1-compat).
      await device.verifyVersion();
      await this.disable();
      await this.setBias(bias);
      await this.setLPF(lpf);
      await this.setLogLevel(log_level);
    })();
  }

  get connected() {
    return this.device.connected;
  }
  get enabled() {
    return this._enabled;
  }
  get pos() {
    return this._pos;
  }
  /** See `ready` — set once `verifyVersion()` resolves. CMD_STREAM/CMD_FRAME
   *  (createStream/frame below) don't exist at all on v1 firmware, unlike
   *  actuate/trigger's v1-compat fallback — so they hard-require this. */
  get v2Capable() {
    return this.device.v2Capable;
  }
  /** Cumulative serial byte/packet counters (docs/history/refactor/orchestrator.md
   *  §7.1 S4 added scope) — the caller derives rates by diffing successive
   *  samples, same pattern as `streamSnapshot()`'s Hz. */
  get stats() {
    return this.device.stats;
  }

  /** Live per-stream `{id, hz, left, right}` snapshot, resetting each
   *  stream's call counter — call at a fixed interval (`intervalSec`) so
   *  `hz` is meaningful. */
  streamSnapshot(
    intervalSec: number,
  ): Array<{ id: number; hz: number; left: Pos; right: Pos }> {
    const out: Array<{ id: number; hz: number; left: Pos; right: Pos }> = [];
    for (const [id, s] of this.streamStats) {
      out.push({ id, hz: s.count / intervalSec, left: s.left, right: s.right });
      s.count = 0;
    }
    return out;
  }

  release() {
    this.serialMeter.dispose();
    this.device.release();
  }

  // `prop: any` like set() below: the d.ts `PacketFactory` type is not
  // exported, and `Parameters<Device["get"]>[0]` collapses the generic to
  // PacketFactory<unknown>, which no concrete factory is assignable to
  // (contravariant input). Callers pin the decode type via <T>.
  private get<T>(prop: any) {
    if (!this.device.connected) throw new Error("Controller not connected");
    // A GET is one serial write too — same observe-only accounting as set()
    // below (A-29; covers readTimestamp's calibration pings).
    this.serialMeter.emit("packets");
    return this.device.get(prop) as Promise<T>;
  }
  private set<T>(prop: any, arg: T) {
    if (!this.device.connected) throw new Error("Controller not connected");
    // Covers enable/disable/setBias/setLPF/setLogLevel/trigger — every config
    // + command write routed through here is one serial packet.
    this.serialMeter.emit("packets");
    return this.device.set(prop, arg as any);
  }

  get info() {
    return this.device.get(Protocol.System.Info);
  }
  get version() {
    return this.device.get(Protocol.System.Version);
  }

  async enable() {
    await this.set(Protocol.System.Enable, true);
    this._enabled = true;
  }
  async disable() {
    this._pos = origin;
    await this.set(Protocol.System.Enable, false);
    this._enabled = false;
  }

  /** Clock-calibration ping (unified-time proposal §2, Rulings 4): the MCU's
   *  current clock in MICROSECONDS as a uint64 `bigint`, stamped
   *  firmware-side at packet parse time so the reading's jitter stays at the
   *  serial-latency floor. RAW BY CONTRACT — this is the calibration
   *  primitive itself; owner-applied dt (setClockOffsetNs) deliberately does
   *  NOT apply here, unlike every other surfaced timestamp. Requires
   *  firmware >= v1.1 (older firmware REJects the unknown property). */
  async readTimestamp(): Promise<bigint> {
    const ts = await this.get<BigInt>(Protocol.System.Timestamp);
    return ts.valueOf();
  }
  /** Resets the MCU clock counter to 0 (SET System.Timestamp) — the ONLY
   *  clock reset since v1.1 (enable() no longer resets time). Invalidates
   *  any prior offset calibration: re-ping after using this. */
  async resetTimestamp(): Promise<void> {
    await this.set(Protocol.System.Timestamp, 0n);
  }

  setLogLevel(level: LogLevel) {
    return this.set(Protocol.Config.Log, level);
  }
  setLPF(value: number) {
    return this.set(Protocol.Config.LPF, value);
  }
  async setBias(value: number) {
    const bias = await this.set(Protocol.Config.Bias, volt2dac(value));
    this.bias = dac2volt(Number(bias));
    return this.bias;
  }

  async actuate(pos: { left?: Pos; right?: Pos }, settleTime = 0) {
    // `settle_time`/`complete_time` are the NATIVE core `Device.set` protocol
    // field names (B-owned) — they stay snake_case at this boundary; only the
    // wire-facing param/return are camelCased (A-P7).
    this.serialMeter.emit("packets");
    // `measure` times the actuate round-trip as busy while running the send
    // unchanged (span stays open until the awaited set settles).
    const { left, right, complete_time } = await this.serialMeter.measure(() =>
      this.device.set(Protocol.Command.Actuate, {
        left: channels(pos.left ?? this._pos.left, this.bias, this.dv),
        right: channels(pos.right ?? this._pos.right, this.bias, this.dv),
        settle_time: settleTime,
      }),
    );
    const new_pos = { left: decodeChannels(left), right: decodeChannels(right) };
    this._pos = new_pos;
    return { ...new_pos, completeTime: complete_time ?? 0 };
  }

  /**
   * Locally predict the actuated volts for `pos` WITHOUT a serial round-trip:
   * the exact `channels()`→`dac2volt` math `actuate()` applies to the ACK
   * readback, assuming the firmware echoes the commanded channels (A-30 ruling
   * Q1; RIG-VERIFY predicted vs a sampled real readback). This lets the fire-
   * and-forget streaming actuation path (the controller thread node,
   * `controller-node.ts`) publish telemetry /
   * fovea-wrap volts without paying the awaited readback the streaming protocol
   * has no response for anyway. Pure: reads only `pos`, `_pos` (fallback for an
   * unspecified axis), `bias`, and `dv` — no serial I/O, no mutation.
   */
  predictVolts(pos: { left?: Pos; right?: Pos }): { left: Pos; right: Pos } {
    return {
      left: decodeChannels(channels(pos.left ?? this._pos.left, this.bias, this.dv)),
      right: decodeChannels(channels(pos.right ?? this._pos.right, this.bias, this.dv)),
    };
  }

  /** Mirror a STREAMED target into the local `pos` (v2 fire-and-forget has no
   *  readback). The controller node feeds the predicted volts it just applied so
   *  `pos` stays live for readers that expect the awaited-actuate invariant —
   *  calibrate voltage capture, drift derivation. LOCAL only: sends nothing to
   *  the wire (the CMD_STREAM update already carries the command). */
  applyStreamedPos(pos: { left: Pos; right: Pos }): void {
    this._pos = { left: clonePos(pos.left), right: clonePos(pos.right) };
  }

  trigger(duration_ns: number) {
    return this.set(Protocol.Command.Trigger, duration_ns);
  }

  // --- Protocol v2: streams + synced-frame requests -----------------------
  // docs/history/refactor/synced-capture.md §3.2/§6. Deliberately independent of
  // `this._pos`/`actuate()` — mixing Actuate writes with an active stream
  // leaves `Streams::snapshot()` reporting the stream's target rather than
  // the DAC's actual (Actuate-set) state (§9 FW5); callers should pick one.

  /** Creates a CMD_STREAM (id auto-allocated, 0..63 — Streams::CAPACITY).
   *  ACK-backed (protocol-level single-phase: ACK/REJ, no FIN — §3.2/§9). */
  async createStream(pos: { left: Pos; right: Pos }): Promise<StreamHandle> {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "createStream requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    const id = this.streamIds.allocate();
    try {
      this.serialMeter.emit("packets");
      await this.device.set(Protocol.Command.MirrorStream, {
        op: "CREATE",
        id,
        left: channels(pos.left, this.bias, this.dv),
        right: channels(pos.right, this.bias, this.dv),
      });
    } catch (error) {
      this.streamIds.release(id);
      throw error;
    }
    this.streamStats.set(id, { count: 0, left: pos.left, right: pos.right });
    const gate = new StreamUpdateGate(pos);
    let closed = false;
    return {
      id,
      update: (next) => {
        if (closed) throw new Error(`Stream ${id} is closed`);
        if (!gate.accept(next)) return;
        this.device.fireAndForget(Protocol.Command.MirrorStream, {
          op: "UPDATE",
          id,
          left: channels(next.left, this.bias, this.dv),
          right: channels(next.right, this.bias, this.dv),
        });
        // The ~kHz-capable stream hot path — `emit` is an O(1) counter bump,
        // never a gate on the fire-and-forget write.
        this.serialMeter.emit("packets");
        const stats = this.streamStats.get(id);
        if (stats) {
          stats.count++;
          stats.left = next.left;
          stats.right = next.right;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          this.serialMeter.emit("packets");
          await this.device.set(Protocol.Command.MirrorStream, {
            op: "TERMINATE",
            id,
          });
        } finally {
          this.streamIds.release(id);
          this.streamStats.delete(id);
        }
      },
    };
  }

  /**
   * native-compose-controller.md: create the MCU stream (ACK-backed, same
   * guards as {@link createStream}) and attach a NATIVE pos_in sink to the
   * device's write seam — the UPDATE path (gate + channels() + fire-and-
   * forget + history) then runs entirely native off a port link's delivery
   * thread. JS KEEPS stream lifecycle ownership: `close()` releases the sink
   * (writes stop) and TERMINATEs the stream (FW5 + quiesce unchanged).
   */
  async createNativeMirrorSink(
    pos: { left: Pos; right: Pos },
    nodeId = "controller",
  ): Promise<NativeMirrorSinkHandle> {
    const stream = await this.createStream(pos);
    const sink = createMirrorSink(this.device, {
      streamId: stream.id,
      bias: this.bias,
      dv: this.dv,
      nodeId,
    });
    let closed = false;
    return {
      sink,
      close: async () => {
        if (closed) return;
        closed = true;
        sink.release(); // stop native writes FIRST
        await stream.close(); // then TERMINATE (best-effort on a dead device)
      },
    };
  }

  /** Issues a CMD_FRAME triggered-capture request on `stream` (§3.2/§5).
   *  Two-phase: `.accepted` resolves on ACK (queue position; rejects on
   *  REJ) independently of the returned promise, which resolves on FIN with
   *  the exposure-AVERAGED mirror voltage (B-12; converted to volts like
   *  `actuate()`) plus the FIN `frameId` and the MCU trigger/exposure
   *  timestamps — feed these to `sync.ts`'s `calibrate`/`matchPair` for L/R
   *  pairing, and `frameId` binds the voltage to the recorded frame (4b). */
  frame(opts: {
    stream: number;
    cameras?: CameraName[] | number;
    pulse?: number;
    /** v2.0 trigger settle HOLD (µs) — the firmware holds the trigger this
     *  long after a stream SWITCH (mirror moved to this stream's target), then
     *  runs the normal exposure. Independent of `pulse` (NOT subtracted from
     *  exposure). Omitted/0 = fire immediately (pre-v2.0 behavior). */
    settle_time?: number;
  }): Promise<FrameOutcome> & { accepted: Promise<unknown> } {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "frame requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    this.serialMeter.emit("packets");
    const req = this.device.get(Protocol.Command.Frame, opts as FrameArg);
    const accepted = req.accepted;
    const completed = (async (): Promise<FrameOutcome> => {
      const result = await req;
      return {
        frameId: result.frame_id,
        stream: result.stream,
        // Owner-applied trusted time (unified-time ruling 0): raw MCU µs →
        // host-steady ns at THE decode boundary. No downstream correction.
        tTrigger: result.t_trigger * 1000n + this.clockOffsetNs,
        tExposure: result.t_exposure * 1000n + this.clockOffsetNs,
        left: {
          x: dac2volt(result.left[0] - result.left[1]),
          y: dac2volt(result.left[2] - result.left[3]),
        },
        right: {
          x: dac2volt(result.right[0] - result.right[1]),
          y: dac2volt(result.right[2] - result.right[3]),
        },
      };
    })();
    return Object.assign(completed, { accepted });
  }
}

// --- Shared device handle ------------------------------------------------
// The controller session connects/owns the serial device, but orchestrator
// control loops (e.g. the tracking session) must actuate the *same* device.
// This module-level holder is that single point of truth; the session sets it
// on connect and clears it on disconnect.
let active: Controller | null = null;
export const activeController = (): Controller | null => active;
export const setActiveController = (c: Controller | null): void => {
  active = c;
};
