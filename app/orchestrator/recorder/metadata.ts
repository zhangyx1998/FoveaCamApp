// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Per-frame recorder metadata schema: the .fovea telemetry channel carries one JSON doc
// per frame with extras ({stream, seq, t, ...extras}, correlated by (stream, seq)). This
// module pins the DECODER-FACING shape of those extras (pyfovea/viewer read them) + the
// frame↔voltage binding builder. RecordingSink.write(extra) stays generic (unknown keys
// pass through) — this schema documents the BLESSED keys, it does not gate them.
// spec: docs/spec/capture-recording.md#recorder-metadata

/** MEMS mirror voltage {x, y} in volts. Structural (Pos-shaped) so the
 *  recorder does not couple to `@lib/controller-codec`. */
export type Volt = { x: number; y: number };

/** Provenance of a recorded frame's `volt`:
 *  - `"fin-averaged"` — the EXPOSURE-AVERAGED voltage from the CMD_FRAME
 *    FIN (round-half-up mean of the strobe-rise and strobe-fall DAC targets),
 *    i.e. the voltage that actually produced this frame (TRIGGER mode, from the
 *    pairing anchors);
 *  - `"history-interpolated"` — the mirror voltage at the frame's exposure
 *    host-time, LINEARLY INTERPOLATED from the orchestrator's timestamped
 *    actuation history (`orchestrator/mirror-history.ts`). This is the FREE-RUN
 *    provenance: there is no FIN pairing, so the recorder samples the mirror
 *    trajectory at the frame's trusted host-ns instead. Commands (not a
 *    measured exposure average), so it carries the actuation LPF group delay —
 *    honest, and distinct from `"fin-averaged"`;
 *  - `"live-snapshot"` — a controller reading taken at frame arrival (not
 *    bracketed to the exposure window). */
export type VoltSource = "fin-averaged" | "history-interpolated" | "live-snapshot";

/** Blessed keys of a recorded frame's per-frame telemetry extras (the payload
 *  of the `.fovea` `telemetry` channel doc, beyond `{stream, seq, t}`). All
 *  optional and additive — this is the documented schema decoders rely on, not
 *  an exhaustive type of what `write()` accepts. */
export interface RecordedFrameExtras {
  /** Firmware-monotonic capture id from the FIN: stable frame identity
   *  binding this recorded frame to the CMD_FRAME that produced it. Correlated
   *  to the camera frame host-side via the FIN `t_exposure`/timestamp pairing. */
  frame_id?: number;
  /** This stream's mirror voltage. When `volt.source === "fin-averaged"` it is
   *  the exposure-averaged value; otherwise a live at-arrival snapshot. */
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

/** Build the frame↔voltage binding extras for one recorded frame from
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
