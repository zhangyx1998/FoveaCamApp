// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native compose brick + controller pos_in sink (docs/proposals/
// native-compose-controller.md) — NO hardware. Proves:
//   1. COMPOSE CONFORMANCE — shared vectors (docs/schema/codec/
//      compose-vectors.json, generated from the wave-1 JS composeVolts
//      reference): rebase + a piped prediction tick reproduce
//      V = V_pid + J·(p_pred − p_meas); feedForward=false and a coasted miss
//      hold the baseline; every rebase emits the baseline FLOOR.
//   2. GATE — the native stream-update gate replicates the JS
//      StreamUpdateGate: dedupe (same pose → no write) + 1 ms min interval
//      (counted, never blocking the link delivery thread).
//   3. WIRE — UPDATE frames actually land on the serial fd (a PTY pair —
//      `__serialTestPty`; the Device opens the slave, the test reads the
//      master) and decode to CMD_STREAM UPDATE packets with the exact
//      channels() DAC math; history records the predictVolts-parity
//      DAC round-trip volts.
//   4. HISTORY — ring recording + historyLatest/historyAt (mirrorAt-parity
//      interpolation + clamped ends) + historyQuery range.
//   5. TEARDOWN under load + FW5-adjacent: link release mid-flood, then
//      Device release mid-flow — the write seam closes FIRST, sink writes
//      become counted no-ops (open:false), no crash, no further bytes.
//
// Run UNSANDBOXED: node core/test/45-native-compose.ts

import assert from "node:assert/strict";
import { readFileSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Controller, Tracker, cleanup } from "core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type XY = { x: number; y: number };
type Volts = { left: XY; right: XY };
type Compose = {
  rebase(p: {
    vPid: { l: XY; r: XY };
    pMeas?: XY;
    jL?: number[];
    jR?: number[];
    feedForward?: boolean;
  }): void;
  probe(): { inputs: Record<string, { count: number }>; outputs: Record<string, { count: number }> };
  pred_in: { streamTag: string };
  volt_out: { streamTag: string; pipe(t: unknown, o?: unknown): Link };
  release(): void;
  [Symbol.asyncIterator](): AsyncIterator<Volts>;
};
type Link = { probe(): { written: number; delivered: number }; release(): void };
type PredSource = {
  predict_out: { streamTag: string; pipe(t: unknown, o?: unknown): Link };
  push(p: { found: boolean; center: XY | null; seq?: number }): void;
  release(): void;
};
type Sink = {
  pos_in: { streamTag: string };
  probe(): {
    received: number; written: number; deduped: number;
    throttled: number; errors: number; open: boolean;
  };
  historyLatest(): { tNs: bigint; left: XY; right: XY } | null;
  historyAt(tNs: bigint): { left: XY; right: XY; ageNs: bigint; interpolated: boolean } | null;
  historyQuery(fromNs: bigint, toNs: bigint): Array<{ tNs: bigint }>;
  release(): void;
};

const T = Tracker as unknown as {
  createComposeStream(o: { name: string; initial: { l: XY; r: XY } }): Compose;
  createTestPredictionSource(id: string): PredSource;
};
const C = Controller as unknown as {
  Device: new (path: string) => { release(): void };
  createMirrorSink(dev: unknown, o: { streamId: number; bias?: number; dv?: number; nodeId?: string }): Sink;
  __serialTestPty(): { fd: number; path: string };
};

interface Fixture {
  tolerance: number;
  vectors: Array<{
    seq: number;
    rebase: {
      vPid: { l: XY; r: XY };
      pMeas: XY;
      jL: number[];
      jR: number[];
      feedForward: boolean;
    };
    pred: { found: boolean; center: XY | null };
    expected: { l: XY; r: XY };
  }>;
}
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../docs/schema/codec/compose-vectors.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

// --- 1: compose conformance -----------------------------------------------------
{
  const compose = T.createComposeStream({
    name: "win/45/compose",
    initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } },
  });
  const src = T.createTestPredictionSource("test/45/imm");
  assert.equal(src.predict_out.streamTag, "prediction", "predict_out tag");
  assert.equal(compose.pred_in.streamTag, "prediction", "pred_in tag");
  assert.equal(compose.volt_out.streamTag, "volts", "volt_out tag");
  const link = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 16 });

  const it = compose[Symbol.asyncIterator]();
  const next = async (): Promise<Volts> => {
    const r = await Promise.race([
      it.next(),
      sleep(8000).then(() => {
        throw new Error("compose emit timed out");
      }),
    ]);
    return (r as IteratorResult<Volts>).value;
  };
  const tol = fixture.tolerance;
  const close = (a: number, b: number, what: string) =>
    assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

  let seq = 0;
  for (const v of fixture.vectors) {
    compose.rebase(v.rebase);
    const floor = await next();
    // Planner decision 4: EVERY rebase emits the baseline floor.
    close(floor.left.x, v.rebase.vPid.l.x, `vector ${v.seq} floor l.x`);
    close(floor.right.y, v.rebase.vPid.r.y, `vector ${v.seq} floor r.y`);
    src.push({ found: v.pred.found, center: v.pred.center, seq: ++seq });
    const tick = await next();
    close(tick.left.x, v.expected.l.x, `vector ${v.seq} tick l.x`);
    close(tick.left.y, v.expected.l.y, `vector ${v.seq} tick l.y`);
    close(tick.right.x, v.expected.r.x, `vector ${v.seq} tick r.x`);
    close(tick.right.y, v.expected.r.y, `vector ${v.seq} tick r.y`);
  }
  await it.return?.();
  link.release();
  src.release();
  compose.release();
  console.log(
    `45-native-compose: conformance OK — ${fixture.vectors.length} vectors match the JS composeVolts reference (floor + tick).`,
  );
}

// --- helpers for the sink phases --------------------------------------------------
// Tiny COBS decode + packet parse (lib/COBS framing: 0x00-delimited frames;
// packet = header(method|property, checksum? layout: [0]=xor checksum settled
// by finalize at byte1? — we assert only the STABLE facts: frame count, frame
// length, the MirrorStream payload tail: op, id, 8×uint16 LE channels).
function cobsDecode(frame: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < frame.length) {
    const code = frame[i]!;
    for (let j = 1; j < code && i + j < frame.length; j++) out.push(frame[i + j]!);
    i += code;
    if (code < 0xff && i < frame.length) out.push(0);
  }
  // trailing phantom zero from the loop above (frame never ends mid-block)
  if (out[out.length - 1] === 0) out.pop();
  return Buffer.from(out);
}
function drainFrames(fd: number): Buffer[] {
  const buf = Buffer.alloc(65536);
  let n = 0;
  try {
    n = readSync(fd, buf, 0, buf.length, null);
  } catch {
    return []; // EAGAIN — nothing buffered
  }
  const frames: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) {
      if (i > start) frames.push(cobsDecode(buf.subarray(start, i)));
      start = i + 1;
    }
  }
  return frames;
}
// @lib/controller-codec channels() reimplemented for the wire assertion.
const volt2dac = (v: number): number => Math.min(65535, Math.max(0, (65535 * v) / 200)) | 0;
function channels(p: XY, bias: number, dv: number): number[] {
  const ch = (volt: number, d: number): [number, number] => {
    const v = Math.min(d, Math.max(-d, volt / 2));
    return [volt2dac(bias + v), volt2dac(bias - v)];
  };
  return [...ch(p.x, dv / 2), ...ch(p.y, dv / 2)];
}

// --- 2 + 3 + 4: gate, wire framing, history ---------------------------------------
{
  const pty = C.__serialTestPty();
  const dev = new C.Device(pty.path);
  const sink = C.createMirrorSink(dev, { streamId: 5, bias: 90, dv: 170, nodeId: "controller" });
  assert.equal(sink.pos_in.streamTag, "volts", "pos_in tag");

  const compose = T.createComposeStream({
    name: "win/45/compose2",
    initial: { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } },
  });
  const voltLink = compose.volt_out.pipe(sink.pos_in); // latest (production shape)

  const drive = (l: XY, r: XY) =>
    compose.rebase({ vPid: { l, r }, feedForward: false });

  // First pose → 1 write.
  drive({ x: 10, y: 20 }, { x: 30, y: 40 });
  await sleep(50);
  {
    const p = sink.probe();
    assert.equal(p.written, 1, "first pose written");
    assert.equal(p.errors, 0, "no write errors");
  }
  // Same pose repeatedly → DEDUPED, no extra writes. NOTE the volt link is
  // LATEST (the production shape): the Leaky channel may itself shed some of
  // the duplicates before they reach the sink, so the deterministic contract
  // is `written stays 1` + `at least one duplicate was gate-deduped`.
  for (let i = 0; i < 5; i++) {
    drive({ x: 10, y: 20 }, { x: 30, y: 40 });
    await sleep(5);
  }
  {
    const p = sink.probe();
    assert.equal(p.written, 1, "identical poses dedupe (no extra writes)");
    assert(p.deduped >= 1, `dedupe counted (${p.deduped})`);
  }
  // Distinct poses spaced beyond the 1 ms gate → each writes.
  for (let i = 1; i <= 5; i++) {
    drive({ x: 10 + i, y: 20 }, { x: 30, y: 40 });
    await sleep(5);
  }
  {
    const p = sink.probe();
    assert.equal(p.written, 6, "spaced distinct poses all write");
  }
  // Distinct poses FASTER than 1 ms → throttled (min interval). Two flake
  // traps to avoid (both hit in accepted-run loops):
  //  - a LATEST volt link can shed the burst down to >1 ms-apart deliveries;
  //  - a REBASE burst is legitimately COALESCED by the brick (iterate reads
  //    the CURRENT linearization, so queued floor events all emit the LAST
  //    pose → dedupe, never throttle).
  // Deterministic proof: PREDICTION ticks carry their center IN the event, so
  // 20 distinct predictions through FIFO links (pred + volt — lossless, back-
  // to-back on the delivery threads) MUST produce distinct sub-ms volts, and
  // the second-and-later ones MUST hit the 1 ms gate.
  {
    const fifoVolt = compose.volt_out.pipe(sink.pos_in, { type: "fifo", depth: 32 });
    const src = T.createTestPredictionSource("test/45/throttle-src");
    const fifoPred = src.predict_out.pipe(compose.pred_in, { type: "fifo", depth: 32 });
    compose.rebase({
      vPid: { l: { x: 50, y: 20 }, r: { x: 30, y: 40 } },
      pMeas: { x: 0, y: 0 },
      jL: [0.1, 0, 0, 0.1],
      jR: [0.1, 0, 0, 0.1],
      feedForward: true,
    });
    await sleep(20); // let the floor emit land
    for (let i = 0; i < 20; i++)
      src.push({ found: true, center: { x: 10 + i, y: 0 }, seq: i + 1 });
    await sleep(100);
    const p = sink.probe();
    assert(p.throttled > 0, `min-interval throttling engaged (${p.throttled})`);
    assert(p.written < 30, "burst did not all reach the wire");
    fifoPred.release();
    src.release();
    fifoVolt.release();
  }

  // WIRE: frames decode to CMD_STREAM UPDATE with the exact channels() DACs.
  const frames = drainFrames(pty.fd);
  const p = sink.probe();
  assert.equal(frames.length, p.written, `one COBS frame per written UPDATE (${frames.length}/${p.written})`);
  {
    // First frame = the first pose. Payload tail: [-18..] op(1) id(1) 8×u16 LE.
    const f = frames[0]!;
    const payload = f.subarray(f.length - 18);
    assert.equal(payload[0], 1, "op == UPDATE");
    assert.equal(payload[1], 5, "stream id");
    const expect = [...channels({ x: 10, y: 20 }, 90, 170), ...channels({ x: 30, y: 40 }, 90, 170)];
    for (let i = 0; i < 8; i++)
      assert.equal(payload.readUInt16LE(2 + i * 2), expect[i], `DAC channel ${i}`);
  }
  console.log(`45-native-compose: gate (dedupe+throttle) + wire framing (${frames.length} UPDATEs decoded) OK.`);

  // HISTORY: latest reflects the last WRITTEN pose (DAC round-trip volts);
  // interpolation + range + clamped ends behave like the JS mirrorAt.
  {
    const latest = sink.historyLatest();
    assert(latest, "history has samples");
    const q = sink.historyQuery(0n, latest!.tNs);
    assert.equal(q.length, sink.probe().written, "one history sample per write");
    // Clamped BEFORE the span.
    const before = sink.historyAt(q[0]!.tNs - 1000n);
    assert(before && !before.interpolated, "pre-span query clamps (interpolated=false)");
    // Midpoint between two samples interpolates.
    if (q.length >= 2) {
      const a = q[q.length - 2]!.tNs, b = q[q.length - 1]!.tNs;
      const mid = sink.historyAt((a + b) / 2n);
      assert(mid && mid.interpolated, "mid-span query interpolates");
    }
    // DAC round-trip parity: |recorded − commanded| < one DAC step (~3 mV·2).
    assert(Math.abs(latest!.left.y - 20) < 0.01, `history volts ≈ commanded (${latest!.left.y})`);
  }
  console.log("45-native-compose: history ring (latest/at/query, mirrorAt parity) OK.");

  // --- 5: teardown under load + FW5-adjacent seam close --------------------------
  // Flood ticks while links churn (the port-pipe release-under-load discipline).
  const src = T.createTestPredictionSource("test/45/imm2");
  compose.rebase({
    vPid: { l: { x: 1, y: 1 }, r: { x: 1, y: 1 } },
    pMeas: { x: 0, y: 0 }, jL: [0.01, 0, 0, 0.01], jR: [0.01, 0, 0, 0.01],
    feedForward: true,
  });
  let seq = 0;
  const flood = setInterval(() => {
    for (let i = 0; i < 5; i++) src.push({ found: true, center: { x: ++seq % 400, y: 7 }, seq });
  }, 1);
  for (let i = 0; i < 10; i++) {
    const l = src.predict_out.pipe(compose.pred_in);
    await sleep(10);
    l.release(); // release under producer load
  }
  const keep = src.predict_out.pipe(compose.pred_in);
  await sleep(50);
  const beforeRelease = sink.probe().written;
  assert(beforeRelease > 6, `flood reached the wire (${beforeRelease})`);

  // Device release MID-FLOW: the seam closes FIRST → sink writes become
  // counted no-ops (open:false), never a crash / a write on a dead fd.
  dev.release();
  await sleep(30);
  const afterClose = sink.probe();
  assert.equal(afterClose.open, false, "seam closed on device release");
  const wrote = afterClose.written;
  await sleep(60); // flood continues against the closed seam
  const later = sink.probe();
  assert.equal(later.written, wrote, "no writes after the seam closed");
  assert(later.errors > 0, `post-close writes counted as errors (${later.errors})`);
  clearInterval(flood);
  keep.release();
  voltLink.release();
  src.release();
  compose.release();
  sink.release();
  console.log("45-native-compose: teardown under load + FW5 seam close (no writes after disconnect) OK.");
}

cleanup();
console.log("45-native-compose: native compose + controller pos_in passed.");
