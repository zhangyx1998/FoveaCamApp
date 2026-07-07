// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-frame recorder metadata schema (WS4 4b). The `.fovea` `telemetry`
// channel carries one JSON document per frame that has extras — `{stream, seq,
// t, ...extras}`, correlated to its raw frame by (stream, seq). This module
// pins the DECODER-FACING shape of those extras (pyfovea/viewer read them) and
// the builder for the B-12 frame↔voltage binding.
//
// `RecordingSink.write(extra)` stays generic (`Record<string, unknown>`) so
// unknown keys still pass through — this schema documents the BLESSED keys, it
// does not gate them.

/** MEMS mirror voltage {x, y} in volts. Structural (Pos-shaped) so the
 *  recorder does not couple to `@lib/controller-codec`. */
export type Volt = { x: number; y: number };

/** Provenance of a recorded frame's `volt`:
 *  - `"fin-averaged"` — the B-12 EXPOSURE-AVERAGED voltage from the CMD_FRAME
 *    FIN (round-half-up mean of the strobe-rise and strobe-fall DAC targets),
 *    i.e. the voltage that actually produced this frame;
 *  - `"live-snapshot"` — a controller reading taken at frame arrival (the
 *    pre-4b behavior; not bracketed to the exposure window). */
export type VoltSource = "fin-averaged" | "live-snapshot";

/** Blessed keys of a recorded frame's per-frame telemetry extras (the payload
 *  of the `.fovea` `telemetry` channel doc, beyond `{stream, seq, t}`). All
 *  optional and additive — this is the documented schema decoders rely on, not
 *  an exhaustive type of what `write()` accepts. */
export interface RecordedFrameExtras {
  /** Firmware-monotonic capture id from the FIN (B-12): stable frame identity
   *  binding this recorded frame to the CMD_FRAME that produced it. Correlated
   *  to the camera frame host-side via the FIN `t_exposure`/timestamp pairing. */
  frame_id?: number;
  /** This stream's mirror voltage. When `volt.source === "fin-averaged"` it is
   *  the B-12 exposure-averaged value; otherwise a live at-arrival snapshot. */
  volt?: Volt;
  "volt.unit"?: "volt";
  /** Where `volt` came from — see {@link VoltSource}. */
  "volt.source"?: VoltSource;
  /** Mirror angle {x, y}. */
  angle?: { x: number; y: number };
  "angle.unit"?: "radian";
  /** 3×3 homography (row-major, 9 numbers) for this stream. */
  affine?: number[];
}

/** Build the frame↔voltage binding extras (WS4 4b) for one recorded frame from
 *  a FIN completion: the capture `frameId` + that stream's mirror
 *  exposure-averaged `volt`. Merge the result into the frame's `extra` so the
 *  recorded frame carries the averaged MEMS voltage that produced it, e.g.
 *  `sink.write(name, frame, format, t, { ...frameVoltageExtras(frameId, V), angle, affine })`. */
export function frameVoltageExtras(frameId: number, volt: Volt): RecordedFrameExtras {
  return {
    frame_id: frameId,
    volt: { x: volt.x, y: volt.y },
    "volt.unit": "volt",
    "volt.source": "fin-averaged",
  };
}
