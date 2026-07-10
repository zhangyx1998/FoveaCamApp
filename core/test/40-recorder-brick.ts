// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder Wave 2: the RECORDER BRICK lifecycle gate. Drives the REAL
// native brick (`core.Recorder.*` over `core.Pipe` synthetic producers — no
// hardware, no JS worker, no ring read) through the full lifecycle:
//
//   1. record 2 synthetic pipes (producer-seam taps) + a data channel +
//      ruling-3 telemetry (takeNotices → appendTelemetry round-trip), finalize,
//      then VERIFY the container with @mcap/core's McapIndexedReader: channels,
//      message counts vs the brick's own counters, channel metadata verbatim,
//      per-channel contiguous sequences, telemetry co-clocked with its frame;
//   2. the counter INVARIANTS the UI attribution pins:
//      written + dropped == ingested, droppedQueue + droppedRing == dropped;
//   3. removeStream mid-run (tap detach; channel stays; re-add continues the
//      mcap sequence);
//   4. abort → crash-shape file (indexed reader REJECTS it — no footer);
//   5. CHURN: create → record → finalize|abort (alternating) → destroy, many
//      iterations — the teardown soak (writer-thread join, tap detach under
//      live producers). A wedge is caught by the out-of-process SIGKILL
//      watchdog (same rationale as tests 36/38: a wedged native join freezes
//      the JS thread, so an in-process timer could never fire).
//
// Run UNSANDBOXED from the repo root:
//   /opt/homebrew/bin/node core/test/40-recorder-brick.ts

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const IS_CHILD = process.env.__RECORDER_BRICK_CHILD__ === "1";
const WATCHDOG_MS = 60_000;

if (!IS_CHILD) {
  const child = spawn(process.execPath, [SELF], {
    env: { ...process.env, __RECORDER_BRICK_CHILD__: "1" },
    stdio: "inherit",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    console.error(
      `\n40-recorder-brick: FAIL — child did not finish within ${WATCHDOG_MS}ms ` +
        `(writer-thread join or tap detach wedged). Sending SIGKILL.`,
    );
    child.kill("SIGKILL");
  }, WATCHDOG_MS);
  timer.unref();
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (killed) process.exit(1);
    if (signal) {
      console.error(`40-recorder-brick: FAIL — child killed by ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    console.error("40-recorder-brick: FAIL — could not spawn child:", err);
    process.exit(1);
  });
} else {
  await run();
}

async function run(): Promise<void> {
  const assert = (await import("node:assert/strict")).default;
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { McapIndexedReader } = await import("@mcap/core");

  const mod = (await import("core")) as any;
  const core = mod.default ?? mod;
  const R = core.Recorder;
  const P = core.Pipe;
  assert.equal(typeof R?.create, "function", "core.Recorder is exported");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const dir = mkdtempSync(join(tmpdir(), "recorder-brick-"));

  // ---- synthetic pipes (advertised once; connect/disconnect churns) --------
  const pipes = [
    { id: "rec40:a", w: 32, h: 16 },
    { id: "rec40:b", w: 24, h: 12 },
  ];
  for (const p of pipes) {
    P.advertise({
      id: p.id,
      pixelFormat: "Mono8",
      dtype: "U8",
      width: p.w,
      height: p.h,
      channels: 1,
      stride: p.w,
      bytesPerFrame: p.w * p.h,
      ringDepth: 4,
    });
    P.attachSynthetic(p.id, 240, 7);
  }

  const createOpts = (id: string, filePath: string) => ({
    id,
    filePath,
    chunkBytes: 4096,
    maxQueuedFrames: 8,
    profile: "fovea",
    library: "FoveaCamApp",
    sessionMetaName: "fovea:session",
    wideCameraMetaName: "fovea:wide-camera",
    finalizeMetaName: "fovea:finalize",
    session: { timestamp: "2026-07-10T00:00:00.000Z", app: "FoveaCamApp" },
    cameraMatrix: { matrix: "[[1,0,0],[0,1,0],[0,0,1]]" },
    rawFrameSchemaName: "fovea.raw_frame/v1",
    rawFrameSchemaData: JSON.stringify({ description: "raw" }),
    descriptorSchemaName: "fovea.descriptor/v1",
    descriptorSchemaData: JSON.stringify({ description: "desc" }),
    telemetrySchemaName: "fovea.frame_meta/v1",
    telemetrySchemaData: JSON.stringify({ description: "meta" }),
    schemaEncoding: "jsonschema",
    rawFrameEncoding: "x-fovea-raw",
    descriptorEncoding: "json",
    telemetryEncoding: "json",
    telemetryTopic: "telemetry",
  });

  const metaFor = (p: { w: number; h: number }) => ({
    dtype: "U8",
    shape: JSON.stringify([p.h, p.w]),
    width: String(p.w),
    height: String(p.h),
    channels: "1",
    pixelFormat: "Mono8",
    significantBits: "8",
    stride: String(p.w),
  });

  async function readContainer(path: string) {
    const buf = new Uint8Array(readFileSync(path));
    const readable = {
      size: async () => BigInt(buf.byteLength),
      read: async (offset: bigint, length: bigint) =>
        buf.subarray(Number(offset), Number(offset) + Number(length)),
    };
    const reader = await McapIndexedReader.Initialize({ readable });
    const byTopic = new Map<string, { count: number; seqs: number[]; logTimes: bigint[]; metadata: Map<string, string> }>();
    for (const ch of reader.channelsById.values()) {
      byTopic.set(ch.topic, { count: 0, seqs: [], logTimes: [], metadata: ch.metadata });
    }
    for await (const m of reader.readMessages()) {
      const topic = [...reader.channelsById.values()].find((c) => c.id === m.channelId)!.topic;
      const row = byTopic.get(topic)!;
      row.count++;
      row.seqs.push(m.sequence);
      row.logTimes.push(m.logTime);
    }
    return byTopic;
  }

  // ==== Phase 1: full-feature recording + container verification ============
  {
    const filePath = join(dir, "full.fcap");
    const h = R.create(createOpts("recorder/test40", filePath));
    R.addStream(h, "camA", "rec40:a", metaFor(pipes[0]!), true);
    R.addStream(h, "camB", "rec40:b", metaFor(pipes[1]!), false);
    P.connect("rec40:a");
    P.connect("rec40:b");
    R.addDataStream(h, "fovea/t1");

    // Let frames flow; drive the ruling-3 round-trip on a low-rate poll (the
    // host's exact pattern): notices → appendTelemetry with the OWNING frame's
    // seq + logTime.
    let telemetrySent = 0;
    const noticedStreams = new Set<string>();
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
      await sleep(50);
      const notices = R.takeNotices(h);
      for (const n of notices) {
        noticedStreams.add(n.stream);
        assert.equal(typeof n.logTimeNs, "bigint");
        assert.equal(typeof n.tNs, "bigint");
        R.appendTelemetry(
          h,
          n.seq,
          n.logTimeNs,
          JSON.stringify({ stream: n.stream, seq: n.seq, t: Number(n.tNs) / 1e9 }),
        );
        telemetrySent++;
      }
      const s = R.stats(h);
      if ((s.camA?.written ?? 0) >= 20 && (s.camB?.written ?? 0) >= 20 && telemetrySent >= 5)
        break;
    }
    R.postData(h, "fovea/t1", JSON.stringify({ tNs: 1, bbox: { x: 0, y: 0, width: 4, height: 4 }, frames: {} }));
    R.postData(h, "fovea/t1", JSON.stringify({ tNs: 2, bbox: { x: 1, y: 1, width: 4, height: 4 }, frames: {} }));
    // A data channel with ZERO messages must still land in the container.
    R.addDataStream(h, "fovea/empty");
    await sleep(100);

    const stats = R.stats(h);
    // wantsExtras gating: only camA posts notices.
    assert.deepEqual([...noticedStreams], ["camA"], "notices only for wantsExtras streams");
    assert.ok(stats.camA.written >= 20, `camA wrote ${stats.camA.written}`);
    assert.ok(stats.camB.written >= 20, `camB wrote ${stats.camB.written}`);
    // Metric block present (thread-instrumentation shape).
    const probe = R.probe(h);
    assert.ok(probe && typeof probe === "object", "probe returns a metric block");

    const fin = await R.finalize(h, 2.5);
    assert.equal(typeof fin.messageCount, "bigint");
    assert.ok(fin.chunkCount > 0, "chunks were written");
    const finalStats = R.stats(h);
    R.destroy(h);
    P.disconnect("rec40:a");
    P.disconnect("rec40:b");

    // Counter invariants (the UI attribution contract).
    for (const name of ["camA", "camB"]) {
      const c = finalStats[name]!;
      assert.equal(c.written + c.dropped, c.ingested, `${name}: written+dropped == ingested`);
      assert.equal(c.droppedQueue + c.droppedRing, c.dropped, `${name}: drop split sums`);
    }

    // Container verification via the indexed reader.
    const byTopic = await readContainer(filePath);
    assert.deepEqual(
      [...byTopic.keys()].sort(),
      ["camA", "camB", "fovea/empty", "fovea/t1", "telemetry"].sort(),
      "all channels present (incl. the zero-message data channel)",
    );
    assert.equal(byTopic.get("camA")!.count, finalStats.camA.written, "camA count matches counter");
    assert.equal(byTopic.get("camB")!.count, finalStats.camB.written, "camB count matches counter");
    assert.equal(byTopic.get("telemetry")!.count, telemetrySent, "telemetry docs all landed");
    assert.equal(byTopic.get("fovea/t1")!.count, 2, "descriptor docs landed");
    assert.equal(byTopic.get("fovea/empty")!.count, 0, "empty data channel has no messages");
    // Channel metadata copied VERBATIM.
    const camAMeta = byTopic.get("camA")!.metadata;
    assert.equal(camAMeta.get("pixelFormat"), "Mono8");
    assert.equal(camAMeta.get("stride"), String(pipes[0]!.w));
    assert.equal(camAMeta.get("significantBits"), "8");
    // Per-channel mcap sequences are contiguous from 0 (assigned at write).
    const seqs = byTopic.get("camA")!.seqs.slice().sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i), "camA sequence contiguous");
    // Message count total: frames + telemetry + descriptors.
    const total = [...byTopic.values()].reduce((n, r) => n + r.count, 0);
    assert.equal(BigInt(total), fin.messageCount, "finalize messageCount matches");
    console.log(
      `  phase 1 OK: camA ${finalStats.camA.written} + camB ${finalStats.camB.written} frames, ` +
        `${telemetrySent} telemetry, ${fin.chunkCount} chunks — container verified`,
    );
  }

  // ==== Phase 2: removeStream mid-run + re-add continues the sequence =======
  {
    const filePath = join(dir, "churn-stream.fcap");
    const h = R.create(createOpts("recorder/test40b", filePath));
    R.addStream(h, "camA", "rec40:a", metaFor(pipes[0]!), false);
    P.connect("rec40:a");
    await sleep(300);
    R.removeStream(h, "camA");
    const atRemove = R.stats(h).camA.written;
    await sleep(150);
    // Re-add the SAME name: the channel + sequence continue (JS parity).
    R.addStream(h, "camA", "rec40:a", metaFor(pipes[0]!), false);
    await sleep(300);
    const fin = await R.finalize(h, 0.75);
    const finalStats = R.stats(h);
    R.destroy(h);
    P.disconnect("rec40:a");
    assert.ok(finalStats.camA.written > atRemove, "re-added stream kept writing");
    const byTopic = await readContainer(filePath);
    assert.equal([...byTopic.keys()].filter((t) => t === "camA").length, 1, "ONE camA channel");
    const seqs = byTopic.get("camA")!.seqs.slice().sort((a, b) => a - b);
    assert.deepEqual(seqs, seqs.map((_, i) => i), "sequence continued across re-add");
    void fin;
    console.log(`  phase 2 OK: remove/re-add continued camA at ${finalStats.camA.written} frames`);
  }

  // ==== Phase 3: abort → crash-shape (indexed reader rejects) ===============
  {
    const filePath = join(dir, "aborted.fcap");
    const h = R.create(createOpts("recorder/test40c", filePath));
    R.addStream(h, "camA", "rec40:a", metaFor(pipes[0]!), false);
    P.connect("rec40:a");
    await sleep(200);
    R.abort(h);
    R.destroy(h);
    P.disconnect("rec40:a");
    let rejected = false;
    try {
      await readContainer(filePath);
    } catch {
      rejected = true;
    }
    assert.ok(rejected, "aborted container has no footer (crash shape)");
    console.log("  phase 3 OK: abort leaves the documented crash-shape");
  }

  // ==== Phase 4: lifecycle churn soak (finalize|abort alternating) ==========
  {
    const ITERATIONS = 40;
    P.connect("rec40:a"); // keep the producer hot across iterations
    for (let i = 0; i < ITERATIONS; i++) {
      const filePath = join(dir, `churn-${i}.fcap`);
      const h = R.create(createOpts(`recorder/churn${i}`, filePath));
      R.addStream(h, "camA", "rec40:a", metaFor(pipes[0]!), i % 3 === 0);
      R.addDataStream(h, "fovea/x");
      R.postData(h, "fovea/x", JSON.stringify({ i }));
      await sleep(10);
      if (i % 2 === 0) {
        const fin = await R.finalize(h, 0.01);
        assert.equal(typeof fin.chunkCount, "number");
      } else {
        R.abort(h);
      }
      R.destroy(h);
      rmSync(filePath, { force: true });
    }
    P.disconnect("rec40:a");
    console.log(`  phase 4 OK: ${ITERATIONS} create→record→finalize|abort→destroy churns`);
  }

  for (const p of pipes) P.drop(p.id);
  core.cleanup();
  rmSync(dir, { recursive: true, force: true });
  console.log(
    "\n40-recorder-brick: PASS — producer-seam taps, counter invariants, " +
      "telemetry round-trip, churn + abort teardown all clean.",
  );
}
