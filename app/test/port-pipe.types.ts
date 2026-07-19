// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// COMPILE-TIME harness for the native port/pipe d.ts. Type-only — never
// imported at runtime; compiled by the vue-tsc gate via an explicit tsconfig
// `include` entry. Every `@ts-expect-error` line FAILS the gate if a d.ts
// change makes the illegal call compile (TS flags an unused directive), and
// the legal calls fail it if the surface breaks. Runtime tags are pinned to
// these same payloads by core/test/42 + 44 (runtime and compile time must
// agree).

import type {
  Compose,
  ImmPrediction,
  ImmPredictor,
  KcfTracker,
  TrackResult,
} from "core/Tracker";
import type { MirrorSink } from "core/Controller";
import type { InPort, OutPort, PortLink } from "../../core/dist/types";

declare const tracker: KcfTracker;
declare const imm: ImmPredictor;
declare const detectIn: InPort<{ marker: number }>; // a DIFFERENT payload brand

// --- legal surface -------------------------------------------------------------

// The proving case: kcf.track_out.pipe(imm.measure_in) — payloads agree.
const link: PortLink = tracker.track_out.pipe(imm.measure_in);
void link.probe().highWater;
link.release();

// Per-type params on their own type.
tracker.track_out.pipe(imm.measure_in, { type: "latest" });
tracker.track_out.pipe(imm.measure_in, { type: "fifo", depth: 16 });
tracker.track_out.pipe(imm.measure_in, { type: "ring", size: 4 });

// Ports carry their identity + tag (runtime strings pinned by test 42/44).
const outPort: OutPort<TrackResult> = tracker.track_out;
const inPort: InPort<TrackResult> = imm.measure_in;
void outPort.streamTag satisfies string | void;
void inPort.port satisfies string | void;

// --- illegal surface (each line MUST stay an error) ------------------------------

// Payload mismatch: a track out-port cannot pipe into a differently-branded in.
// @ts-expect-error — payload brand mismatch (TrackResult vs marker payload)
tracker.track_out.pipe(detectIn);

// Per-type params cannot cross the discriminated union.
// @ts-expect-error — `depth` is a fifo param, not a latest one
tracker.track_out.pipe(imm.measure_in, { type: "latest", depth: 8 });
// @ts-expect-error — `size` is a ring param, not a fifo one
tracker.track_out.pipe(imm.measure_in, { type: "fifo", size: 8 });
// @ts-expect-error — `depth` is a fifo param, not a ring one
tracker.track_out.pipe(imm.measure_in, { type: "ring", depth: 8 });
// @ts-expect-error — unknown link type
tracker.track_out.pipe(imm.measure_in, { type: "unbounded" });

// Direction: out→out and in→in do not connect.
// @ts-expect-error — cannot pipe an out-port into another OUT-port
tracker.track_out.pipe(tracker.track_out);
// @ts-expect-error — an in-port has no pipe()
imm.measure_in.pipe(tracker.track_out);

// --- compose lanes ---------------------------------------------------------------

declare const compose: Compose;
declare const sink: MirrorSink;

// Legal: imm → compose (prediction brand) and compose → controller (volts).
compose.pred_in satisfies InPort<ImmPrediction> | void;
imm.predict_out.pipe(compose.pred_in);
compose.volt_out.pipe(sink.pos_in, { type: "latest" });

// Illegal cross-lane pipes: brands must not unify.
// @ts-expect-error — a volts out-port cannot feed a prediction in-port
compose.volt_out.pipe(compose.pred_in);
// @ts-expect-error — a prediction out-port cannot feed the controller pos_in
imm.predict_out.pipe(sink.pos_in);
// @ts-expect-error — a track out-port cannot feed the compose pred_in
tracker.track_out.pipe(compose.pred_in);

// The prediction stream stays a separate shape from the ports.
declare const pred: ImmPrediction;
void pred;

export {};
