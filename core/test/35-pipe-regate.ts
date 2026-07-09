// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// F1 producer-gate RESTART regression (capture-recorder-nodes). On the live
// rig, a manual-control CAPTURE that reuses a `camera/<serial>/raw` pipe id a
// prior RECORDING already used-and-retired hangs forever: readSeqInto returns
// NotYet indefinitely because the producer gate never (re)fires on the fresh
// epoch, so the raw producer never publishes.
//
// This test reproduces the RECORDING→CAPTURE id-reuse hardware-free two ways:
//   (A) the PLAIN Pipe publisher/consumer surface with the recording test gate
//       (installTestGate/testGateLog) — isolates PipeHub epoch/refcount/gate.
//   (B) the REAL raw pipe (attachRawPipe on the Aravis fake camera) driven
//       through the recorder's exact readSeqInto consumption loop — the closest
//       model of the rig path the NAPI surface allows.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/35-pipe-regate.ts

import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Aravis, Pipe, __origin__, cleanup } from "core";

type ReaderHandle = object;
type Ok = { seq: bigint; width: number; height: number };
type Gone = { gone: true; oldestSeq: bigint };
type NotYet = { notYet: true };
type Closed = { closed: true };
type SeqResult = Ok | Gone | NotYet | Closed | null;
type ReaderAddon = {
  open(seg: string): ReaderHandle;
  readSeqInto(h: ReaderHandle, dest: ArrayBuffer, wantSeq: bigint): SeqResult;
  close(h: ReaderHandle): void;
};

const require = createRequire(import.meta.url);
const prefix = basename(__origin__, ".node");
const reader = require(
  join(dirname(__origin__), `${prefix}-shm-reader.node`),
) as ReaderAddon;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isOk = (r: SeqResult): r is Ok =>
  typeof r === "object" && r !== null && "seq" in r;
const isGone = (r: SeqResult): r is Gone =>
  typeof r === "object" && r !== null && (r as Gone).gone === true;
const isClosed = (r: SeqResult): r is Closed =>
  typeof r === "object" && r !== null && (r as Closed).closed === true;

const P = Pipe as unknown as {
  advertise(spec: Record<string, unknown>): number;
  connect(id: string): { shmName: string; epoch: number };
  disconnect(id: string): number;
  consumers(id: string): number;
  offerFrame(id: string, w: number, h: number, byte: number): void;
  installTestGate(id: string): void;
  testGateLog(id: string): boolean[];
  close(id: string): void;
  drop(id: string): void;
};
const A = Aravis as unknown as {
  enableFakeCamera(): void;
  attachRawPipe(camera: unknown, pipeId: string): boolean;
  detachRawPipe(pipeId: string): boolean;
  rawProbeAll(): Record<string, { inputs: { frame: { count: number } } }>;
  Camera: {
    list(): Promise<
      Array<{
        serial?: string;
        grab(t: number): Promise<{
          raw: { shape: number[]; channels?: number; BYTES_PER_ELEMENT: number };
          release?(): void;
        }>;
        release?(): void;
      }>
    >;
  };
};

// ===========================================================================
// (A) PLAIN Pipe surface: recording gate log across a drop → re-advertise reuse
// ===========================================================================
// Mirrors the rig's own-thread producer as `offerFrame`, and the raw producer's
// consumer gate as the recording test gate. The producer only publishes while
// the gate is TRUE — so if the gate never re-fires true on the reused epoch,
// offerFrame writes nothing and the reader hangs on NotYet (exactly F1).
{
  const id = "camera/regate-plain/raw";
  const spec = {
    id, pixelFormat: "Mono8", dtype: "U8", width: 4, height: 4, channels: 1,
    stride: 4, bytesPerFrame: 16, ringDepth: 4,
  };
  const dest = new ArrayBuffer(16);

  const readOne = (rh: ReaderHandle, want: bigint): Ok => {
    for (let i = 0; i < 200; i++) {
      const r = reader.readSeqInto(rh, dest, want);
      if (isOk(r)) return r;
      if (isGone(r)) { want = r.oldestSeq; continue; }
      // NotYet / null / closed → the producer hasn't published this seq.
    }
    throw new Error(`plain: reader stuck on NotYet for seq ${want} (F1)`);
  };

  // ---- RECORDING session: advertise → gate → connect → publish → read -------
  const e1 = P.advertise(spec);
  P.installTestGate(id);                 // gate arm on epoch 1 (refcount 0)
  assert.deepEqual(P.testGateLog(id), [false], "plain rec: arm fires false");
  const h1 = P.connect(id);              // 0→1 edge → gate true → producer live
  assert.equal(h1.epoch, e1);
  assert.deepEqual(P.testGateLog(id), [false, true], "plain rec: 0→1 fires true");
  const rh1 = reader.open(h1.shmName);
  P.offerFrame(id, 4, 4, 0x11);
  assert.equal(Number(readOne(rh1, 1n).seq), 1, "plain rec: frame delivered");

  // ---- RETIRE: disconnect → detach(gate null) → close → drop ----------------
  reader.close(rh1);
  P.disconnect(id);                      // 1→0 edge → gate false
  assert.deepEqual(P.testGateLog(id), [false, true, false], "plain rec: →0 fires false");
  P.installTestGate(id);                 // detach-analog: re-arm clears prior log
  // (installTestGate reconciles to CURRENT refcount; after disconnect it is 0.)
  assert.deepEqual(P.testGateLog(id), [false], "plain retire: refcount 0 at retire");
  P.close(id);
  P.drop(id);

  // ---- CAPTURE session: REUSE the same id (epoch bumps) ---------------------
  const e2 = P.advertise(spec);
  assert(e2 > e1, `plain cap: epoch bumped ${e1}→${e2}`);
  assert.equal(P.consumers(id), 0, "plain cap: fresh epoch starts with 0 consumers");
  P.installTestGate(id);                 // gate arm on epoch 2 (must fire false)
  assert.deepEqual(P.testGateLog(id), [false], "plain cap: arm fires false on fresh epoch");
  const h2 = P.connect(id);              // 0→1 edge MUST fire true again
  assert.notEqual(h2.shmName, h1.shmName, "plain cap: reused id → new segment");
  assert.deepEqual(
    P.testGateLog(id), [false, true],
    "plain cap: RE-ACQUIRE 0→1 MUST re-fire the gate true (F1 gate)",
  );
  const rh2 = reader.open(h2.shmName);
  P.offerFrame(id, 4, 4, 0x22);
  const got = readOne(rh2, 1n);          // hangs here if the producer is dead
  assert.equal(Number(got.seq), 1, "plain cap: producer publishes on reused epoch");
  reader.close(rh2);
  P.disconnect(id);
  P.close(id);
  P.drop(id);
  console.log("35-pipe-regate (A) plain surface: reuse re-fires gate + delivers OK.");
}


// ===========================================================================
// (B) REAL raw pipe: RECORDING then CAPTURE reuse of camera/<serial>/raw
// ===========================================================================
A.enableFakeCamera();
const cams = await A.Camera.list();
assert(cams.length > 0, "fake camera enumerated");
const camera = cams[0]!;
const probe = await camera.grab(2_000_000);
const [H, W] = probe.raw.shape as [number, number];
const CH = probe.raw.channels ?? (probe.raw.shape.length === 3 ? probe.raw.shape[2]! : 1);
const BPE = probe.raw.BYTES_PER_ELEMENT;
probe.release?.();
const bytesPerFrame = W * H * CH * BPE;

const ID = `camera/${camera.serial ?? "fake"}/raw`;
const RING = 8;
const rawSpec = {
  id: ID, pixelFormat: "Mono8", dtype: BPE > 1 ? "U16" : "U8",
  width: W, height: H, channels: CH, stride: W * CH * BPE, bytesPerFrame,
  ringDepth: RING,
};

// One full attach→connect→FIFO-read→retire session over the raw pipe — the
// recorder's exact `readSeqInto` consumption loop. Returns the epoch used.
const session = async (label: string): Promise<number> => {
  const epoch = P.advertise(rawSpec);              // advertise (bumps on reuse)
  assert.equal(A.attachRawPipe(camera, ID), true, `${label}: attach`);
  await sleep(120);
  assert.equal(
    A.rawProbeAll()[ID]?.inputs.frame.count, 0,
    `${label}: parked before connect (consumer gate holds producer off)`,
  );
  const { shmName } = P.connect(ID);               // 0→1 edge → gate must fire
  const rh = reader.open(shmName);
  const dst = new ArrayBuffer(bytesPerFrame);
  const WANT = 5;
  const delivered: number[] = [];
  let want = 1;
  const deadline = Date.now() + 6000;
  while (delivered.length < WANT && Date.now() < deadline) {
    const r = reader.readSeqInto(rh, dst, BigInt(want));
    if (r === null) continue;
    if (isClosed(r)) throw new Error(`${label}: unexpected CLOSED`);
    if (isGone(r)) { want = Number(r.oldestSeq); continue; }
    if (isOk(r)) { delivered.push(want); want += 1; continue; }
    await sleep(3); // NotYet
  }
  assert.equal(
    delivered.length, WANT,
    `${label}: FIFO delivered ${WANT} frames (epoch ${epoch}) — ` +
      `got ${delivered.length}; producer never published ⇒ F1 gate bug`,
  );
  // Retire in the EXACT rig order (raw-pipe.ts registry release + recorder-node
  // release): reader close → disconnect (consumer refcount→0) → detach (gate
  // cleared) → drop (== the app's `unadvertise`; pipe-session maps it to
  // Pipe.drop). No explicit close — the app never calls it.
  reader.close(rh);
  P.disconnect(ID);
  assert.equal(A.detachRawPipe(ID), true, `${label}: detach`);
  P.drop(ID);
  console.log(`35-pipe-regate (B) ${label}: delivered ${WANT} @ epoch ${epoch}.`);
  return epoch;
};

const eRec = await session("RECORDING");
const eCap = await session("CAPTURE-reuse");
assert(eCap > eRec, `raw reuse bumped epoch ${eRec}→${eCap}`);

// ---- ROOT-CAUSE PIN (real gated producer): the gate re-registration on the
// fresh epoch is the LOAD-BEARING restart coupling. `attachRawPipe` →
// `hub.setConsumerGate` is what makes connect()'s 0→1 edge (re)spawn the
// RawPipeSubscriber. Skipping the re-attach after reuse leaves the fresh segment
// valid-but-empty and the producer parked → readSeqInto NotYet forever (F1).
// Proven with a BOUNDED read budget (no hang) on both branches.
{
  const drains = async (rh: ReaderHandle, budgetMs: number): Promise<boolean> => {
    const dst = new ArrayBuffer(bytesPerFrame);
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const r = reader.readSeqInto(rh, dst, 1n);
      if (isOk(r)) return true;
      if (isGone(r)) return true; // producer ran (frames recycled past seq 1)
      await sleep(4);
    }
    return false; // NotYet for the whole budget == the F1 hang
  };

  // Failure branch: re-advertise + connect, but DO NOT re-attach → no gate →
  // producer never wakes. (This is exactly the app-side skip the raw-pipe
  // registry structurally prevents by re-attaching on every 0→1 acquire.)
  P.advertise(rawSpec);
  const noGate = P.connect(ID);
  const rhNo = reader.open(noGate.shmName);
  const woke = await drains(rhNo, 400);
  assert.equal(
    woke, false,
    "root: reuse WITHOUT re-attach leaves the producer parked (F1 mechanism) — " +
      "the consumer 0→1 edge has no gate to fire on the fresh epoch",
  );
  reader.close(rhNo);
  P.disconnect(ID);
  P.drop(ID); // discard this un-attached epoch

  // Correct branch: re-advertise AND re-attach → gate re-armed → connect wakes
  // the producer → reads drain. This is what the shipped app does.
  const eFix = P.advertise(rawSpec);
  assert.equal(A.attachRawPipe(camera, ID), true, "root: re-attach re-arms the gate");
  const fixed = P.connect(ID);
  const rhFix = reader.open(fixed.shmName);
  assert(
    await drains(rhFix, 3000),
    `root: re-attach on the fresh epoch (${eFix}) restarts the producer — reads drain`,
  );
  reader.close(rhFix);
  P.disconnect(ID);
  A.detachRawPipe(ID);
  P.drop(ID);
  console.log("35-pipe-regate (B') root-cause pin: gate re-arm (attach) restarts the producer.");
}

camera.release?.();
cleanup();
console.log("35-pipe-regate: raw-pipe RECORDING→CAPTURE id-reuse re-gates OK.");
