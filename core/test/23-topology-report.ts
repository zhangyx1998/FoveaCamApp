// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// unified-time-and-topology §6: the consolidated `Topology.report()` NAPI —
// one NodeReport[] (graph-contract shape) for every live native brick +
// advertised pipe. NO hardware (fake camera). Proves:
//   1. CHAIN EDGES ARE ACTUAL — convert←camera/<serial>, undistort←convert,
//      fovea←undistort, straight from the live channel connections (no
//      synthesized edges).
//   2. ROW SHAPE — {id, kind, transport, inputs[{from,port,type}], output,
//      epoch, stats(full WorkloadSnapshot schema), pipe:{consumers,
//      bytesTotal}} for pipe-backed bricks.
//   3. BRICK-LESS PIPES — a synthetic pipe reports as {kind:"pipe",
//      transport:"pipe", inputs:[]} (no brick claims it).
//   4. LEGACY PRIVATE CHAINS — a Camera-attached undistort reports its
//      private `<pipeId>#convert` node (transport "native", input
//      camera/<serial>) and chains on it.
//   5. COMPAT SURFACES INTACT — Pipe.list()/Pipe.probeAll()/converterProbeAll
//      keep working unchanged next to Topology.report().
//   6. LIVENESS — detached bricks/dropped pipes vanish from the report.
//      ORDERLY teardown (B-20) → natural exit 0.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/23-topology-report.ts

import assert from "node:assert/strict";
import { Aravis, Pipe, Topology } from "core";

const P = Pipe as any, A = Aravis as any, T = Topology as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mat = (nums: number[], shape: number[]) =>
  Object.assign(new Float64Array(nums), { shape, channels: 1 });

A.enableFakeCamera();
const camera = (await A.Camera.list())[0];
const probe0 = await camera.grab(2_000_000);
const [H, W] = probe0.raw.shape as [number, number];
probe0.release?.();
const serial = String(camera.serial ?? "0");

const f = W * 0.8;
const cal = {
  sensor_size: { width: W, height: H },
  camera_matrix: mat([f, 0, W / 2, 0, f, H / 2, 0, 0, 1], [3, 3]),
  dist_coeffs: mat([0, 0, 0, 0, 0], [1, 5]),
  rvecs: [],
  tvecs: [],
};

const CH = 4;
const bytes = W * H * CH;
const advertise = (id: string) =>
  P.advertise({ id, pixelFormat: "BGRA8", dtype: "U8", width: W, height: H, channels: CH, stride: W * CH, bytesPerFrame: bytes, ringDepth: 4 });

const cnvId = `camera/${serial}/convert`;
const undId = `camera/${serial}/undistort`;
const fovId = `camera/${serial}/undistort/fovea/0`;
const synId = `synthetic/topology-demo`;
const legId = `undistort:${serial}@legacy`;

advertise(cnvId); advertise(undId); advertise(legId);
const R0 = { x: 16, y: 16, width: 64, height: 64 };
P.advertise({ id: fovId, pixelFormat: "BGRA8", dtype: "U8", width: R0.width, height: R0.height, channels: CH, stride: R0.width * CH, bytesPerFrame: R0.width * R0.height * CH, ringDepth: 4 });
P.advertise({ id: synId, pixelFormat: "Mono8", dtype: "U8", width: 32, height: 32, channels: 1, stride: 32, bytesPerFrame: 1024, ringDepth: 4 });
P.attachSynthetic(synId, 30, 7);

assert.equal(A.attachCameraPipe(camera, cnvId), true);
assert.equal(A.attachUndistortPipe(cnvId, undId, { cal }), true);
assert.equal(A.attachFoveaPipe(undId, fovId, { rect: R0 }), true);
assert.equal(A.attachUndistortPipe(camera, legId, cal), true, "legacy camera-arg undistort");

// Make the fovea chain live so stats flow (one consumer at the chain's tail).
const fovHandle = P.connect(fovId);
assert(fovHandle.shmName, "fovea pipe connects");
await sleep(600); // let a few frames flow through the chain

type Row = {
  id: string; kind: string; transport: string;
  inputs: { from: string; port: string; type: { kind: string; pixelFormat?: string; dtype?: string } }[];
  output: { kind: string; pixelFormat?: string } | null;
  epoch?: number; stats?: any; pipe?: { consumers: number; bytesTotal: number };
};
const rows = T.report() as Row[];
assert(Array.isArray(rows), "report returns an array");
const byId = new Map(rows.map((r) => [r.id, r]));

// --- 1+2: the shared chain rows ----------------------------------------------
{
  const cnv = byId.get(cnvId)!;
  assert(cnv, "convert row present");
  assert.equal(cnv.kind, "convert");
  assert.equal(cnv.transport, "pipe", "advertised pipe promotes transport");
  assert.equal(cnv.inputs.length, 1);
  assert.equal(cnv.inputs[0].from, `camera/${serial}`, "convert ← camera (actual edge)");
  assert.equal(cnv.inputs[0].port, "frame");
  assert.equal(cnv.inputs[0].type.kind, "frame");
  assert.equal(cnv.output?.pixelFormat, "BGRA8");
  assert(typeof cnv.epoch === "number" && cnv.epoch >= 1, "epoch");
  assert(cnv.pipe && cnv.pipe.consumers === 0, "convert pipe: zero SHM consumers (tap-demanded)");
  // Full meter schema (window + drops) — the profiler's converged shape.
  assert.equal(cnv.stats.name, cnvId, "stats keyed by node id");
  assert(typeof cnv.stats.window.uptimeMs === "number");
  assert(typeof cnv.stats.utilization === "number");
  assert(typeof cnv.stats.drops.total === "number");
  assert(cnv.stats.outputs.converted.count >= 1, "converter ran (chain demand)");

  const und = byId.get(undId)!;
  assert(und, "undistort row present");
  assert.equal(und.kind, "undistort");
  assert.equal(und.inputs[0].from, cnvId, "undistort ← convert (actual edge)");
  assert.equal(und.transport, "pipe");
  assert(und.pipe && und.pipe.consumers === 0);

  const fov = byId.get(fovId)!;
  assert(fov, "fovea row present");
  assert.equal(fov.kind, "fovea");
  assert.equal(fov.inputs[0].from, undId, "fovea ← undistort (actual edge)");
  assert.equal(fov.pipe?.consumers, 1, "fovea pipe: the one live consumer");
  assert(fov.pipe!.bytesTotal > 0, "fovea pipe wrote bytes");
  assert(fov.stats.outputs.fovea.count >= 1, "fovea produced");
  console.log("23-topology-report: chain rows convert←camera, undistort←convert, fovea←undistort OK.");
}

// --- 3: brick-less synthetic pipe ---------------------------------------------
{
  const syn = byId.get(synId)!;
  assert(syn, "synthetic pipe row present");
  assert.equal(syn.kind, "pipe");
  assert.equal(syn.transport, "pipe");
  assert.equal(syn.inputs.length, 0, "no brick claims it — no inputs");
  assert.equal(syn.output?.pixelFormat, "Mono8");
  assert(typeof syn.epoch === "number");
  assert(syn.stats, "publisher meter stats present");
  console.log("23-topology-report: brick-less pipe row OK.");
}

// --- 4: legacy private chain ---------------------------------------------------
{
  const leg = byId.get(legId)!;
  assert(leg, "legacy undistort row present");
  assert.equal(leg.inputs[0].from, `${legId}#convert`, "legacy undistort ← private converter");
  const priv = byId.get(`${legId}#convert`)!;
  assert(priv, "private converter row present");
  assert.equal(priv.kind, "convert");
  assert.equal(priv.transport, "native", "private brick has no pipe");
  assert.equal(priv.inputs[0].from, `camera/${serial}`);
  assert.equal(priv.output?.pixelFormat, "BGRA8");
  console.log("23-topology-report: legacy private-chain rows OK.");
}

// --- 5: compat surfaces intact --------------------------------------------------
{
  const list = P.list() as { id: string }[];
  const ids = new Set(list.map((e) => e.id));
  for (const id of [cnvId, undId, fovId, synId, legId]) assert(ids.has(id), `Pipe.list has ${id}`);
  const probes = P.probeAll();
  assert(probes[fovId], "Pipe.probeAll intact");
  assert(A.converterProbeAll()[cnvId], "converterProbeAll intact");
  assert(A.undistortProbeAll()[undId], "undistortProbeAll intact");
  assert(A.foveaProbeAll()[fovId], "foveaProbeAll intact");
  console.log("23-topology-report: compat probe surfaces intact.");
}

// --- 6: liveness — teardown removes rows; natural exit --------------------------
P.disconnect(fovId);
assert.equal(A.detachFoveaPipe(fovId), true);
P.close(fovId); P.drop(fovId);
assert.equal(A.detachUndistortPipe(undId), true);
assert.equal(A.detachUndistortPipe(legId), true);
A.detachCameraPipe(cnvId);
for (const id of [undId, legId, cnvId, synId]) { P.close(id); P.drop(id); }
{
  const after = new Map((T.report() as Row[]).map((r) => [r.id, r]));
  for (const id of [cnvId, undId, fovId, synId, legId, `${legId}#convert`])
    assert(!after.has(id), `${id} gone after teardown`);
  console.log("23-topology-report: teardown removes rows OK.");
}
camera.release();

console.log("23-topology-report: orderly teardown complete — exiting naturally.");
