#!npx ts-node
// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Host-side FrameResult (FIN payload) round-trip + wire-layout check, without
// hardware. The FIN payload carries `frame_id` (uint32) right after `stream`,
// and `left`/`right` carry the EXPOSURE-AVERAGED mirror voltage. Proves the
// native `Protocol.Command.FrameResult` factory encodes/decodes that layout
// exactly, with byte offsets matching the synced-capture wire shape.
// Run: /opt/homebrew/bin/node core/test/10-frame-result.ts

import assert from "node:assert/strict";
import { Protocol } from "core/Controller";
import { cleanup } from "core";

type FrameResultObj = {
  stream: number;
  frame_id: number;
  t_trigger: bigint;
  t_exposure: bigint;
  left: [number, number, number, number];
  right: [number, number, number, number];
};

const FrameResult = Protocol.Command.FrameResult as (
  arg: Partial<FrameResultObj> | Uint8Array,
) => FrameResultObj;

/** The packet bytes hang off the encoded object under a `Symbol(Buffer)`. */
function bytesOf(packet: object): ArrayBuffer {
  const sym = Object.getOwnPropertySymbols(packet).find(
    (s) => (packet as Record<symbol, unknown>)[s] instanceof ArrayBuffer,
  );
  assert(sym, "encoded packet is missing its [Buffer] symbol");
  return (packet as Record<symbol, ArrayBuffer>)[sym];
}

// --- 1. round-trip fidelity ------------------------------------------------
const sample: FrameResultObj = {
  stream: 3,
  frame_id: 42,
  t_trigger: 1000n,
  t_exposure: 2000n,
  left: [10, 20, 30, 40],
  right: [50, 60, 70, 80],
};
const encoded = FrameResult(sample);
const buf = bytesOf(encoded);
const decoded = FrameResult(new Uint8Array(buf));

assert.equal(decoded.stream, sample.stream, "stream survives round-trip");
assert.equal(decoded.frame_id, sample.frame_id, "frame_id survives round-trip");
assert.equal(decoded.t_trigger, sample.t_trigger, "t_trigger survives");
assert.equal(decoded.t_exposure, sample.t_exposure, "t_exposure survives");
assert.deepEqual([...decoded.left], sample.left, "averaged left volts survive");
assert.deepEqual([...decoded.right], sample.right, "averaged right volts survive");

// --- 2. exact wire layout (locks the field order/offsets) -------
// stream(1) + frame_id(4) + t_trigger(8) + t_exposure(8) + left(8) + right(8).
assert.equal(buf.byteLength, 37, "FIN payload is 37 bytes");
const view = new DataView(buf);
assert.equal(view.getUint8(0), 3, "byte 0 = stream");
assert.equal(view.getUint32(1, true), 42, "bytes 1..5 = frame_id (u32 LE)");
assert.equal(view.getBigUint64(5, true), 1000n, "bytes 5..13 = t_trigger (u64 LE)");
assert.equal(view.getBigUint64(13, true), 2000n, "bytes 13..21 = t_exposure (u64 LE)");
assert.equal(view.getUint16(21, true), 10, "byte 21 = left.ch[0] (u16 LE)");
assert.equal(view.getUint16(29, true), 50, "byte 29 = right.ch[0] (u16 LE)");

// --- 3. frame_id is a full uint32 (no truncation to the u16 seq width) ------
const big = FrameResult({ ...sample, frame_id: 0xdead_beef });
const bigDecoded = FrameResult(new Uint8Array(bytesOf(big)));
assert.equal(bigDecoded.frame_id, 0xdead_beef, "frame_id keeps full uint32 range");

// --- 4. full-scale averaged DAC values (0..4095 range) round-trip -----------
const full = FrameResult({ ...sample, left: [0, 4095, 2048, 1], right: [4095, 0, 1, 4094] });
const fullDecoded = FrameResult(new Uint8Array(bytesOf(full)));
assert.deepEqual([...fullDecoded.left], [0, 4095, 2048, 1], "full-scale left survives");
assert.deepEqual([...fullDecoded.right], [4095, 0, 1, 4094], "full-scale right survives");

console.log("10-frame-result: FrameResult round-trip + 37-byte wire layout OK");
cleanup();
