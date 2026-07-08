// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import type { BufferLike } from "../types";

declare module "core/Controller" {
  /** Path to the resolved native module injected by JS loader */
  export const __origin__: string;

  // Internally distinguishable objects that can be converted to buffer.
  const bufferAccessor: unique symbol;
  const factoryAccessor: unique symbol;
  const propNameAccessor: unique symbol;
  type PacketInstance<I, O = I> = Readonly<O> & {
    readonly [bufferAccessor]: ArrayBuffer;
  };

  type PacketFactory<I, O = I> = ((
    v: I | BufferLike,
  ) => PacketInstance<I, O>) & {
    readonly [propNameAccessor]: string;
    readonly [bufferAccessor]: null;
  };

  export type ActuateArg = {
    left: AnalogChannels;
    right: AnalogChannels;
    settle_time?: number; // in microseconds
    complete_time?: number; // in microseconds
  };

  export type CameraName = "C" | "L" | "R";

  export type MirrorStreamOp = "CREATE" | "UPDATE" | "TERMINATE";
  export type MirrorStreamArg = {
    op: MirrorStreamOp;
    id: number; // host-chosen stream id, 0..N-1 (CAPACITY = 64)
    left?: AnalogChannels; // ignored by TERMINATE
    right?: AnalogChannels;
  };
  export type MirrorStreamDecoded = {
    op: MirrorStreamOp;
    id: number;
    left: AnalogChannels;
    right: AnalogChannels;
  };

  export type FrameArg = {
    stream: number;
    // Bitmask (CameraName[] or a raw number); omitted/undefined means
    // the firmware default (CAM_L | CAM_R). "C" is REJected until the
    // center camera has a strobe cable — see
    // docs/history/refactor/synced-capture.md §2/§8.
    cameras?: CameraName[] | number;
    pulse?: number; // trigger pulse width, in microseconds
  };
  export type FrameDecoded = {
    stream: number;
    cameras: CameraName[];
    pulse: number;
  };
  /** CMD_FRAME ACK payload: position in the per-stream FIFO (0 = next). */
  export type FrameAccepted = { queue_position: number };
  /** CMD_FRAME FIN payload, latched at exposure start (strobe rising
   *  edge). Timestamps are MCU microseconds, as `bigint` (uint64,
   *  matching firmware's Global::time — see
   *  docs/history/refactor/synced-capture.md §9 FW1). */
  export type FrameResult = {
    stream: number;
    /** Firmware-monotonic capture id (1-based; 0 = none). Stable frame
     *  identity bound to the camera frame via t_exposure/timestamp; distinct
     *  from the request `seq`. Consumed downstream by the recorder/UI. */
    frame_id: number;
    t_trigger: bigint;
    t_exposure: bigint;
    /** Exposure-AVERAGED mirror position (per-channel round-half-up mean of the
     *  strobe-rise and strobe-fall DAC targets) — replaces the former
     *  start-only latched value. */
    left: AnalogChannels;
    right: AnalogChannels;
  };

  /**
   * Protocol v2 two-phase request (docs/history/refactor/synced-capture.md §3.1/§5):
   * `accepted` resolves on ACK (queued/applied; rejects on REJ) independently
   * of the returned promise itself, which only resolves on FIN (or rejects on
   * a REJ at either phase).
   *
   * `accepted` is only attached once the connection has confirmed v2
   * firmware (`Device.v2Capable`, set by `verifyVersion()`) — against
   * unconfirmed or v1 firmware, `get`/`set` fall back to resolving on ACK
   * alone (no `accepted` property at all), matching v1's blocking behavior.
   * Feature-detect with `"accepted" in result` if you must support both.
   */
  export type TwoPhase<Completed, Accepted = Completed> = Promise<
    PacketInstance<Completed>
  > & {
    accepted: Promise<PacketInstance<Accepted>>;
  };

  export const Protocol: {
    readonly Log: PacketFactory<String>;
    readonly System: {
      readonly Info: PacketFactory<String>;
      readonly Version: PacketFactory<FirmwareVersion> &
        Readonly<FirmwareVersion>;
      readonly Reset: PacketFactory<ResetType>;
      readonly Enable: PacketFactory<Boolean>;
      /** Clock calibration (unified-time proposal, Rulings 4). GET → the
       *  MCU's uint64 MICROSECOND clock as `bigint`, stamped firmware-side
       *  at packet parse time (same Global::time clock/units as
       *  `FrameResult.t_trigger`/`t_exposure`). SET (arg = new counter
       *  value, normally `0n`) resets the counter; the ACK echoes the fresh
       *  clock. Single-phase (ACK/REJ, no FIN). Requires firmware >= v1.1. */
      readonly Timestamp: PacketFactory<BigInt>;
    };
    readonly Config: {
      readonly Log: PacketFactory<LogLevel>;
      readonly LPF: PacketFactory<Number>;
      readonly Bias: PacketFactory<Number>;
    };
    readonly Command: {
      readonly Actuate: PacketFactory<ActuateArg>;
      readonly Trigger: PacketFactory<Number>;
      readonly MirrorStream: PacketFactory<
        MirrorStreamArg,
        MirrorStreamDecoded
      >;
      readonly Frame: PacketFactory<FrameArg, FrameDecoded>;
      readonly FrameAccepted: PacketFactory<FrameAccepted>;
      readonly FrameResult: PacketFactory<FrameResult>;
    };
  };

  export class Device {
    // Properties
    readonly connected: boolean;
    /** See verifyVersion() and TwoPhase above. Starts false. */
    readonly v2Capable: boolean;
    /** Cumulative serial counters for the lifetime of this Device. */
    readonly stats: {
      txBytes: number;
      rxBytes: number;
      txPackets: number;
      rxPackets: number;
    };

    // Two-phase overloads — see TwoPhase above. Must precede the
    // generic fallback overloads below (TS resolves overloads in
    // declaration order).
    set(
      fn: typeof Protocol.Command.Actuate,
      arg: ActuateArg | BufferLike,
    ): TwoPhase<ActuateArg>;
    set(
      fn: typeof Protocol.Command.Trigger,
      arg: number | BufferLike,
    ): TwoPhase<number>;
    get(
      fn: typeof Protocol.Command.Frame,
      arg: FrameArg | BufferLike,
    ): TwoPhase<FrameResult, FrameAccepted>;

    // Single-phase (default): resolves on ACK alone, no `.accepted` —
    // exactly today's (pre-v2) behavior.
    get<T>(fn: PacketFactory<T>): Promise<PacketInstance<T>>;
    set<T>(
      fn: PacketFactory<T>,
      arg: T | BufferLike,
    ): Promise<PacketInstance<T>>;

    /**
     * Sequence == 0 fire-and-forget (docs/history/refactor/synced-capture.md
     * §3.1): the firmware performs the SET but sends no ACK/FIN/REJ at
     * all — no promise, no pending-map entry. Intended for high-rate
     * stream position updates (CMD_STREAM UPDATE, ~1kHz); throws
     * synchronously on a transport/encode failure.
     */
    fireAndForget<T>(fn: PacketFactory<T>, arg: T | BufferLike): void;

    /**
     * Fetches System.Version and sets v2Capable = (firmware.major >=
     * this build's Protocol.System.Version.major). Never rejects on a
     * version *mismatch* — only on a transport/REJ failure — so old
     * firmware simply keeps v2Capable false (v1-compat: every property
     * resolves on ACK, matching pre-v2 behavior) rather than refusing
     * to operate. See docs/history/refactor/synced-capture.md §9.3 (P3.1a).
     */
    verifyVersion(): Promise<FirmwareVersion & { compatible: boolean }>;
    release(): void;
    // Construction
    constructor(
      port: string,
      baudrate?: number, // default 115200
    );
  }

  export type FirmwareVersion = {
    major: number;
    minor: number;
    patch: number;
  };
  export type ResetType = "SOFT" | "HARD";
  export type LogLevel = "OFF" | "ERR" | "WARN" | "INFO" | "VERB";
  export type AnalogChannels = [number, number, number, number];
}
