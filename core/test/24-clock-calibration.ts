// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// unified-time (2026-07-08): native camera clock calibration — owner-thread
// lifecycle, owner-applied dt, steadyNowNs authority, CallbackSlot push
// channel. Camera-less where the latch can't run (the Aravis fake camera has
// no TimestampLatch — which makes the UNSUPPORTED path itself testable).
// Proves:
//   1. steadyNowNs(): bigint, MONOTONIC non-decreasing, advances with wall
//      time (THE host clock authority — all offsets live in its domain).
//   2. __clockCalSelfTest — the min-filter estimator port (min-RTT pick,
//      first-minimal-wins, p90−min jitter, single-sample, empty-throws) runs
//      wholly in C++.
//   3. CallbackSlot gating (via __fireClockMetricsTest, which fires from a
//      SPAWNED NATIVE THREAD — the owner-thread topology, hardware-free):
//      disarmed = no dispatch; armed = the row arrives on the main thread
//      via the Dispatcher; disarm-then-fire = no dispatch again.
//   4. LATCH-UNSUPPORTED lifecycle (fake camera): the owner thread's init
//      pass fails once and exits — camera stays uncalibrated (null getter,
//      absent from clockStabilityAll, frames keep raw timestamps = dt 0);
//      the manual calibrateClock() retry throws; setClockOffset is the
//      documented deprecated no-op. Release/exit joins the calibrator thread
//      (natural exit 0 IS the no-leak proof).
// NOTE: on a rig with real cameras attached, Camera.list() ALSO opens them
// and their owner threads DO latch-calibrate — assertions here are strictly
// per-serial (the fake camera's), never global-emptiness.
// Run UNSANDBOXED: /opt/homebrew/bin/node core/test/24-clock-calibration.ts

import assert from "node:assert/strict";
import { Aravis, steadyNowNs } from "core";

const A = Aravis as any;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- 1: the native time authority --------------------------------------------
{
  const t0 = steadyNowNs();
  assert.equal(typeof t0, "bigint", "steadyNowNs returns bigint");
  let prev = t0;
  for (let i = 0; i < 1000; i++) {
    const t = steadyNowNs();
    assert(t >= prev, "steadyNowNs is monotonic non-decreasing");
    prev = t;
  }
  await sleep(50);
  const dtMs = Number((steadyNowNs() - t0) / 1_000_000n);
  assert(dtMs >= 30 && dtMs < 5000, `steadyNowNs advances with wall time (${dtMs}ms across a 50ms sleep)`);
  console.log("24-clock-calibration: steadyNowNs authority OK.");
}

// --- 2: min-filter estimator port (native self-test) --------------------------
assert.equal(A.__clockCalSelfTest(), true, "min-filter self-test");
console.log("24-clock-calibration: min-filter estimator self-test OK.");

// --- 3: CallbackSlot gating (cross-thread fire → main-thread delivery) --------
{
  const rows: any[] = [];
  // Disarmed: the producer thread sees armed=false and MUST NOT dispatch.
  assert.equal(A.__fireClockMetricsTest("cam-A"), false, "fire reports disarmed");
  await sleep(50);
  assert.equal(rows.length, 0, "disarmed fire delivered nothing");

  A.onClockMetrics((row: any) => rows.push(row));
  assert.equal(A.__fireClockMetricsTest("cam-B"), true, "fire reports armed");
  await sleep(100);
  assert.equal(rows.length, 1, "armed fire delivered exactly one row");
  const row = rows[0];
  assert.equal(row.serial, "cam-B", "row carries the serial");
  assert.equal(typeof row.offsetNs, "bigint", "offsetNs bigint");
  assert.equal(typeof row.jitterNs, "bigint", "jitterNs bigint");
  assert.equal(typeof row.atNs, "bigint", "atNs bigint");
  assert.equal(typeof row.ageNs, "bigint", "ageNs bigint");
  assert.equal(typeof row.samples, "number", "samples number");
  assert.equal(typeof row.driftPpm, "number", "driftPpm present on this synthetic row");

  A.onClockMetrics(null); // disarm
  assert.equal(A.__fireClockMetricsTest("cam-C"), false, "fire reports disarmed again");
  await sleep(50);
  assert.equal(rows.length, 1, "disarm-then-fire delivered nothing");
  console.log("24-clock-calibration: CallbackSlot armed/disarmed gating OK (cross-thread fire).");
}

// --- 4: latch-unsupported lifecycle on the fake camera -------------------------
{
  A.enableFakeCamera();
  const camera = (await A.Camera.list())[0];
  const serial = String(camera.serial ?? "0");
  await sleep(150); // let the owner thread's init pass fail (it exits after)

  assert.equal(camera.clockCalibration, null, "uncalibrated camera reads null");
  assert.equal(A.clockStabilityAll()[serial], undefined, "absent from the bulk stability map");
  assert.throws(() => camera.calibrateClock(2), /TimestampLatch/, "manual retry throws on latch-unsupported");
  assert.equal(camera.clockCalibration, null, "failed retry stores nothing");
  assert.equal(A.setClockOffset(serial, 1000n), 0, "setClockOffset deprecated no-op returns 0");

  // dt = 0 (uncalibrated): frames carry the RAW device counter — grab two and
  // check they advance plausibly (an owner-applied garbage offset would throw
  // the timestamps wildly; equality-of-domain is all we can assert without a
  // latch-capable camera).
  const f0 = await camera.grab(2_000_000);
  const t0 = f0.deviceTimestamp as bigint;
  f0.release?.();
  const f1 = await camera.grab(2_000_000);
  const t1 = f1.deviceTimestamp as bigint;
  f1.release?.();
  assert(t1 > t0, "raw device timestamps advance");
  assert(t1 - t0 < 10_000_000_000n, `frame gap plausible (${t1 - t0}ns) — no phantom offset applied`);

  camera.release(); // joins the (already-exited) calibrator thread
  console.log("24-clock-calibration: latch-unsupported lifecycle OK (uncalibrated, dt=0, clean release).");
}

// Natural exit 0 (no cleanup/process.exit) proves every calibrator thread —
// including those of any REAL cameras this rig has attached — joins cleanly.
console.log("24-clock-calibration: orderly teardown complete — exiting naturally.");
