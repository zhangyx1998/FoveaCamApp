// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SGBM disparity join over EXPOSURE
// PAIRS — `attachStereoPaired`. Instead of two latest-wins OwnedFrame taps, the
// paired brick chains on the always-running `PairStream` brick with ONE record
// tap and runs SGBM per PairRecord (L/R matched by construction). NO hardware —
// two SYNTHETIC ConvertedFrame producers (`createPairTestSource` /
// `pushPairTestFrame`, the latter with an optional deterministic column TEXTURE)
// feed both the pair brick AND a latest-wins reference brick the SAME frames.
//
// Proves:
//   1. ATTACH GUARDS — unknown pipe / unknown pair stage / bad params throw
//      with named errors.
//   2. PARITY — the SAME static L/R pair produces the SAME disparity in paired
//      mode (SGBM per record) as in latest-wins mode (existing brick): the
//      `process(left,right)` compute path is REUSED, not rewritten.
//   3. MEANINGFUL — the paired disparity median tracks the injected horizontal
//      shift D (block matching found the pair).
//   4. ON-DEMAND — with NO consumer the paired brick stays PARKED (zero output)
//      even while the always-running pair brick forms + drops pairs; connecting
//      the disparity pipe wakes it, disconnecting parks it, re-connecting
//      resumes it (ChainedStream consumer gate; the pair brick is unaffected).
//   5. TOPOLOGY — a kind "stereo" row with ONE input edge from the pair node
//      (`pair/<stage>` → `stereo/<name>`, port "pair"); probe reports paired.
//   6. Detach idempotency + orderly teardown → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/34-stereo-paired.ts

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Aravis, Pipe, Topology, __origin__ } from "core";

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(join(dirname(__origin__), `${prefix}-shm-reader.node`)) as {
  open(seg: string): object;
  readInto(h: object, dest: ArrayBuffer, lastSeq: bigint):
    | { seq: bigint; width: number; height: number; originX: number; originY: number; closed?: undefined }
    | { closed: true }
    | null;
  close(h: object): void;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const P = Pipe as any;
const A = Aravis as any;
const T = Topology as unknown as {
  report(): Array<{ id: string; kind: string; inputs: Array<{ from: string; port: string }> }>;
};

const CH = 4; // BGRA8
const W = 160;
const H = 96;
const D = 16; // injected horizontal shift = ground-truth disparity (px)
const NDISP = 64;

const L = "test/pair/src/34/L";
const R = "test/pair/src/34/R";
const stage = "pair/undistort";
const pairedId = "stereo/paired";
const lwId = "stereo/lw"; // latest-wins parity reference

assert.equal(A.createPairTestSource(L), true, "L test source created");
assert.equal(A.createPairTestSource(R), true, "R test source created");
// The always-running pairing brick over the two synthetic sources (ROOT mode:
// a FIN anchor whose tExposure == the frames' deviceTimestamp matches both).
const pair = A.createPairStream(L, R, {
  mode: "root",
  stage,
  anchorFrom: "controller/anchors",
  toleranceNs: 5_000_000n,
});

const f32Bytes = W * H * 4;
const advDisp = (id: string) =>
  P.advertise({ id, pixelFormat: "Disparity32F", dtype: "F32", width: W, height: H, channels: 1, stride: W * 4, bytesPerFrame: f32Bytes, ringDepth: 4, maxWidth: W, maxHeight: H, maxBytes: f32Bytes });
advDisp(pairedId);
advDisp(lwId);

// --- 1: attach guards --------------------------------------------------------
assert.throws(() => A.attachStereoPaired(stage, "stereo/none", {}), /unknown pipe/, "unknown target pipe throws");
assert.throws(() => A.attachStereoPaired("pair/nope", pairedId, {}), /no pairing brick/, "unknown pair stage throws (named)");
assert.throws(() => A.attachStereoPaired(stage, pairedId, { numDisparities: 0 }), /numDisparities/, "bad numDisparities throws");

// matchScale 1: pins the FULL-RES legacy behavior for the parity oracle (the
// brick DEFAULT is the scaled bench winner — stereo-throughput.md).
assert.equal(A.attachStereoPaired(stage, pairedId, { numDisparities: NDISP, matchScale: 1 }), true, "paired stereo attaches on the pair brick");
// The latest-wins reference brick over the SAME two synthetic sources (resolved
// as test sources, same precedent as the pair brick) — the parity oracle.
assert.equal(A.attachStereoPipe(L, R, lwId, { numDisparities: NDISP, matchScale: 1 }), true, "latest-wins stereo attaches on the two sources");

// --- source drive ------------------------------------------------------------
let round = 0;
function pushRound(): void {
  const T0 = BigInt(1_000_000_000 + round * 1_000_000);
  round++;
  // R first (latest-wins retains lastRight before the L tick); textured with a
  // +D column shift so the ground-truth disparity is D everywhere.
  A.pushPairTestFrame(R, { deviceTimestamp: T0, width: W, height: H, texture: true, shift: D });
  A.pushPairTestFrame(L, { deviceTimestamp: T0, width: W, height: H, texture: true, shift: 0 });
  pair.pushAnchor({ tExposure: T0, stream: 0 });
}

type Src = { rh: object; dest: ArrayBuffer; lastSeq: bigint };
const open = (id: string): Src => ({ rh: reader.open(P.connect(id).shmName), dest: new ArrayBuffer(f32Bytes), lastSeq: 0n });
const pull = (s: Src) => {
  const r = reader.readInto(s.rh, s.dest, s.lastSeq);
  if (!r || (r as any).closed) return null;
  s.lastSeq = (r as any).seq;
  return r as { seq: bigint; width: number; height: number; originX: number; originY: number };
};

// --- 4a: parked with no consumer (the pair brick still churns) ----------------
for (let i = 0; i < 20; i++) pushRound();
await sleep(400);
{
  const p = A.stereoProbeAll()[pairedId];
  assert.equal(p.name, pairedId, "paired stereo meter name == pipeId (node id)");
  assert.equal(p.paired, true, "probe reports paired mode");
  assert.equal(p.outputs.disparity.count, 0, "paired brick PARKED before any consumer (no subscriber → no compute)");
  assert(pair.probe().pairsProduced > 0, "the always-running pair brick still formed pairs while the stereo brick was parked");
}
console.log("34-stereo-paired: parked while the pair brick churns OK.");

// Read one valid F32 disparity frame from a pipe (>=5% valid pixels), driving
// the sources; returns the full Float32Array copy + its median of valid px.
async function readDisparity(s: Src): Promise<{ data: Float32Array; median: number }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    pushRound();
    const r = pull(s);
    if (!r) { await sleep(4); continue; }
    assert.equal(r.width, W, "disparity active width");
    assert.equal(r.height, H, "disparity active height");
    const view = new Float32Array(s.dest, 0, W * H);
    const valid: number[] = [];
    for (let i = 0; i < view.length; i++) if (view[i] >= 0 && Number.isFinite(view[i])) valid.push(view[i]);
    if (valid.length < 0.05 * view.length) { await sleep(4); continue; } // warmup
    valid.sort((a, b) => a - b);
    return { data: Float32Array.from(view), median: valid[Math.floor(valid.length / 2)]! };
  }
  throw new Error("no valid disparity frame within the deadline");
}

// --- 4b + 2 + 3: wake on connect, parity vs latest-wins, meaningful median ----
const paired = open(pairedId);
const lw = open(lwId);
const dp = await readDisparity(paired);
const dl = await readDisparity(lw);
{
  const p = A.stereoProbeAll()[pairedId];
  assert(p.outputs.disparity.count >= 1, "paired brick WOKE on the disparity consumer");
  assert(p.inputs.left.count >= 1 && p.inputs.right.count >= 1, "both paired inputs metered (per record)");
  console.log("34-stereo-paired: on-demand wake through the pair record tap OK.");
}
{
  // PARITY: identical static L/R content (deterministic SGBM) → identical map.
  let maxAbs = 0;
  let compared = 0;
  for (let i = 0; i < dp.data.length; i++) {
    const a = dp.data[i]!, b = dl.data[i]!;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    maxAbs = Math.max(maxAbs, Math.abs(a - b));
    compared++;
  }
  assert(compared > 0.5 * dp.data.length, "the two maps overlap on finite pixels");
  assert.equal(maxAbs, 0, `paired disparity is BIT-IDENTICAL to latest-wins on a static pair (maxΔ=${maxAbs})`);
  console.log("34-stereo-paired: parity with latest-wins (compute path reused) OK.");
}
{
  // MEANINGFUL: the median tracks the injected shift (block matching found it).
  assert(dp.median >= D * 0.5 && dp.median <= D * 1.5, `paired median ${dp.median.toFixed(1)}px within ±50% of injected ${D}px`);
  console.log(`34-stereo-paired: meaningful disparity (median ${dp.median.toFixed(1)}px vs injected ${D}px).`);
}

// --- 4c: disconnect parks the brick again ------------------------------------
reader.close(paired.rh); P.disconnect(pairedId);
await sleep(300); // let the in-flight tick drain
const parked = A.stereoProbeAll()[pairedId].outputs.disparity.count as number;
for (let i = 0; i < 10; i++) pushRound();
await sleep(500);
{
  const again = A.stereoProbeAll()[pairedId].outputs.disparity.count as number;
  assert(again - parked <= 1, `paired brick parked after the consumer left (Δ=${again - parked})`);
  console.log("34-stereo-paired: park on disconnect OK.");
}

// --- 4d: re-connect resumes ---------------------------------------------------
const paired2 = open(pairedId);
const dp2 = await readDisparity(paired2);
assert(dp2.median >= D * 0.5 && dp2.median <= D * 1.5, "paired brick RESUMED on re-connect (disparity flows again)");
reader.close(paired2.rh); P.disconnect(pairedId);
console.log("34-stereo-paired: resume on re-connect OK.");

// --- 5: topology row ----------------------------------------------------------
{
  const row = T.report().find((n) => n.id === pairedId);
  assert(row, "paired stereo appears in Topology.report()");
  assert.equal(row!.kind, "stereo", "topology kind == stereo");
  assert.equal(row!.inputs.length, 1, "paired brick reports ONE input edge");
  assert(row!.inputs.some((i) => i.from === stage && i.port === "pair"), "input edge pair/<stage> → stereo, port pair");
  console.log("34-stereo-paired: topology (one pair input edge) OK.");
}

// --- 6: detach idempotency + orderly reverse teardown -------------------------
reader.close(lw.rh); P.disconnect(lwId);
assert.equal(A.detachStereoPipe(pairedId), true, "detach paired stereo");
assert.equal(A.detachStereoPipe(pairedId), false, "paired detach idempotent");
assert.equal(A.stereoProbeAll()[pairedId], undefined, "paired stereo gone from the registry");
assert.equal(A.detachStereoPipe(lwId), true, "detach latest-wins stereo");
for (const id of [pairedId, lwId]) { P.close(id); P.drop(id); }
pair.release();
assert.equal(A.releasePairTestSource(L), true, "release L source");
assert.equal(A.releasePairTestSource(R), true, "release R source");

await sleep(100);
console.log("34-stereo-paired: orderly teardown complete — exiting naturally.");
