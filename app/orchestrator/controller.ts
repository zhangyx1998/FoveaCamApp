// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Orchestrator-side MEMS mirror controller. A non-Vue port of the device logic
// in the renderer `Controller.vue` (state is plain fields; the session reads and
// broadcasts it). Owns the serial `Device`; reuses the shared DAC math.

import { Protocol, Device, type LogLevel } from "core/Controller";
import type { CameraName, FrameArg } from "core/Controller";
import { SerialPort } from "serialport";
import {
  channels,
  dac2volt,
  origin,
  volt2dac,
  type Pos,
} from "@lib/controller-codec";

type PortInfo = Awaited<ReturnType<typeof SerialPort.list>>[number];

// Streams::CAPACITY, firmware/include/Streams.h — fixed-size table on the MCU.
const STREAM_CAPACITY = 8;

/** A CMD_STREAM handle (docs/refactor/synced-capture.md §3.2/§6): a named,
 *  continuously-updatable mirror-position target. `update()` is fire-and-
 *  forget (seq=0, ~1kHz-safe) — it never resolves/rejects, matching the
 *  protocol's design (the firmware sends no response for it at all). */
export interface StreamHandle {
  readonly id: number;
  update(pos: { left: Pos; right: Pos }): void;
  close(): Promise<void>;
}

/** `Controller.frame()`'s decoded result — DAC channels converted to volts,
 *  matching `actuate()`'s existing convention. Distinct from core's raw
 *  `FrameResult` (`core/Controller`), which is in wire units. */
export interface FrameOutcome {
  stream: number;
  tTrigger: bigint;
  tExposure: bigint;
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
  private bias = 0;
  private _enabled = false;
  private _pos: { left: Pos; right: Pos } = origin;
  private readonly streamIdsInUse = new Set<number>();

  constructor(
    info: PortInfo,
    readonly dv: number = 170.0,
    bias: number = 90.0,
    lpf: number = 120,
    log_level: LogLevel = "INFO",
  ) {
    this.device = new Device(info.path);
    const device = this.device;
    this.ready = (async () => {
      // Must run before anything two-phase-sensitive (createStream/frame,
      // and actuate/trigger's `.accepted`) — see P3.1a,
      // docs/refactor/synced-capture.md §9.3. Never throws on a version
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

  release() {
    this.device.release();
  }

  private get<T>(prop: Parameters<Device["get"]>[0]) {
    if (!this.device.connected) throw new Error("Controller not connected");
    return this.device.get(prop) as Promise<T>;
  }
  private set<T>(prop: any, arg: T) {
    if (!this.device.connected) throw new Error("Controller not connected");
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

  async actuate(pos: { left?: Pos; right?: Pos }, settle_time = 0) {
    const { left, right, complete_time } = await this.device.set(
      Protocol.Command.Actuate,
      {
        left: channels(pos.left ?? this._pos.left, this.bias, this.dv),
        right: channels(pos.right ?? this._pos.right, this.bias, this.dv),
        settle_time,
      },
    );
    const new_pos = {
      left: { x: dac2volt(left[0] - left[1]), y: dac2volt(left[2] - left[3]) },
      right: {
        x: dac2volt(right[0] - right[1]),
        y: dac2volt(right[2] - right[3]),
      },
    };
    this._pos = new_pos;
    return { ...new_pos, complete_time: complete_time ?? 0 };
  }

  trigger(duration_ns: number) {
    return this.set(Protocol.Command.Trigger, duration_ns);
  }

  // --- Protocol v2: streams + synced-frame requests -----------------------
  // docs/refactor/synced-capture.md §3.2/§6. Deliberately independent of
  // `this._pos`/`actuate()` — mixing Actuate writes with an active stream
  // leaves `Streams::snapshot()` reporting the stream's target rather than
  // the DAC's actual (Actuate-set) state (§9 FW5); callers should pick one.

  /** Creates a CMD_STREAM (id auto-allocated, 0..7 — Streams::CAPACITY).
   *  ACK-backed (protocol-level single-phase: ACK/REJ, no FIN — §3.2/§9). */
  async createStream(pos: { left: Pos; right: Pos }): Promise<StreamHandle> {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "createStream requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    let id = -1;
    for (let candidate = 0; candidate < STREAM_CAPACITY; candidate++) {
      if (!this.streamIdsInUse.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (id < 0)
      throw new Error(`Stream capacity (${STREAM_CAPACITY}) exceeded`);
    this.streamIdsInUse.add(id);
    try {
      await this.device.set(Protocol.Command.MirrorStream, {
        op: "CREATE",
        id,
        left: channels(pos.left, this.bias, this.dv),
        right: channels(pos.right, this.bias, this.dv),
      });
    } catch (error) {
      this.streamIdsInUse.delete(id);
      throw error;
    }
    let closed = false;
    return {
      id,
      update: (next) => {
        if (closed) throw new Error(`Stream ${id} is closed`);
        this.device.fireAndForget(Protocol.Command.MirrorStream, {
          op: "UPDATE",
          id,
          left: channels(next.left, this.bias, this.dv),
          right: channels(next.right, this.bias, this.dv),
        });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await this.device.set(Protocol.Command.MirrorStream, {
            op: "TERMINATE",
            id,
          });
        } finally {
          this.streamIdsInUse.delete(id);
        }
      },
    };
  }

  /** Issues a CMD_FRAME triggered-capture request on `stream` (§3.2/§5).
   *  Two-phase: `.accepted` resolves on ACK (queue position; rejects on
   *  REJ) independently of the returned promise, which resolves on FIN with
   *  the mirror positions latched at exposure start (converted to volts,
   *  like `actuate()`) plus the MCU trigger/exposure timestamps — feed
   *  these to `sync.ts`'s `calibrate`/`matchPair` for L/R pairing. */
  frame(opts: {
    stream: number;
    cameras?: CameraName[] | number;
    pulse?: number;
  }): Promise<FrameOutcome> & { accepted: Promise<unknown> } {
    if (!this.device.connected) throw new Error("Controller not connected");
    if (!this.device.v2Capable)
      throw new Error(
        "frame requires v2-capable firmware (verifyVersion() has not confirmed compatibility)",
      );
    const req = this.device.get(Protocol.Command.Frame, opts as FrameArg);
    const accepted = req.accepted;
    const completed = (async (): Promise<FrameOutcome> => {
      const result = await req;
      return {
        stream: result.stream,
        tTrigger: result.t_trigger,
        tExposure: result.t_exposure,
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
