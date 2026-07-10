// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Regression: lock-order inversion between a Stream's publisher fan-out and a
// Subscriber's cross-thread close(unsubscribe=true) (core/lib/Stream/Stream.h).
//
//   Publisher (Stream::loop, on the stream thread): takes the stream `mutex`,
//     then for each subscriber takes that subscriber's `state` guard to push.
//   Subscriber::close (on ANOTHER thread — here the JS thread closing an async
//     iterator): pre-fix took the `state` guard FIRST, then called back into
//     Stream::unsubscribe which takes the stream `mutex`. Opposite order → a
//     deadly embrace: the fan-out wedges wanting a state guard the closer holds,
//     the closer wedges wanting the stream mutex the fan-out holds.
//
// close() runs synchronously on the JS thread, so when it wedges it FREEZES the
// JS main thread (event loop dead). An in-process setTimeout watchdog would
// therefore never fire — the watchdog MUST be a separate process. This file
// self-spawns a stress child under a hard SIGKILL watchdog: the child churns
// subscribe → consume → close cycles against a full-rate native producer with a
// wide subscriber set; pre-fix it deadlocks with high probability per run.
//
// Run UNSANDBOXED from the repo root:
//   /opt/homebrew/bin/node core/test/36-stream-close-deadlock.ts

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const IS_CHILD = process.env.__STREAM_DEADLOCK_CHILD__ === "1";
// Generous: a healthy run finishes in a few seconds; a wedged run never exits.
const WATCHDOG_MS = 45_000;

if (!IS_CHILD) {
  // ---- Parent: run the stress child under an out-of-process watchdog --------
  const child = spawn(process.execPath, [SELF], {
    env: { ...process.env, __STREAM_DEADLOCK_CHILD__: "1" },
    stdio: "inherit",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    console.error(
      `\n36-stream-close-deadlock: FAIL — DEADLOCK. The stress child did not ` +
        `finish within ${WATCHDOG_MS}ms; its JS thread is wedged in ` +
        `Subscriber::close() (lock-order inversion). Sending SIGKILL.`,
    );
    child.kill("SIGKILL");
  }, WATCHDOG_MS);
  timer.unref();
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (killed) process.exit(1);
    if (signal) {
      console.error(`36-stream-close-deadlock: FAIL — child killed by ${signal}.`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    console.error("36-stream-close-deadlock: FAIL — could not spawn child:", err);
    process.exit(1);
  });
} else {
  await runStress();
}

async function runStress(): Promise<void> {
  const assert = (await import("node:assert/strict")).default;
  const { Aravis, Tracker, cleanup } = (await import("core")) as any;

  Aravis.enableFakeCamera();
  const cams = await Aravis.Camera.list();
  assert(cams.length > 0, "fake camera enumerated");
  // The fake camera is the one we can grab from; pick the first that grabs.
  let camera: any = null;
  for (const c of cams) {
    try {
      const p = await c.grab(2_000_000);
      const shape = p.raw.shape as number[];
      p.release?.();
      camera = c;
      camera.__shape = shape;
      break;
    } catch {
      /* real FLIR cameras enumerate but cannot connect — skip */
    }
  }
  assert(camera, "a grabbable (fake) camera is available");
  const [height, width] = camera.__shape as [number, number];

  // Full-rate producer: the more frames/sec the fan-out publishes, the higher
  // its stream-mutex duty cycle and the tighter the race window with close().
  try {
    camera.frame_rate_enable = true;
    camera.frame_rate = 1000;
  } catch {
    /* fake camera clamps; whatever it accepts is fine */
  }

  // A KCF tracker Stream: its OUTPUT is plain-data Result objects (not camera
  // Frames), so many idle subscribers do NOT pin the Aravis buffer pool and the
  // producer keeps running at full rate — the property the raw camera stream
  // lacks. Its fan-out is the publisher side of the race.
  const tracker = Tracker.createTracker(camera);
  tracker.arm({
    x: Math.floor(width / 3),
    y: Math.floor(height / 3),
    width: 96,
    height: 96,
  });

  // Background subscribers widen the fan-out's stream-mutex hold: each frame the
  // publisher iterates (and pushes to) ALL of them under the stream mutex. We
  // PUMP them — each keeps an outstanding next() (a pending future), which
  // forces Queue::push down the heavier dispatch() path, so a single fan-out
  // frame holds the stream mutex across dozens of dispatches. That turns the
  // pre-fix race from vanishingly rare into near-certain: a concurrent close()
  // almost always catches the stream mutex held with its own state guard still
  // unreached. (Output is plain-data Result::Ptr → no camera-buffer pinning.)
  const BG = 600;
  let stopBg = false;
  const background: any[] = [];
  const pumps: Promise<void>[] = [];
  for (let i = 0; i < BG; i++) {
    const it = tracker[Symbol.asyncIterator]();
    background.push(it);
    pumps.push(
      (async () => {
        try {
          while (!stopBg) {
            const r = await it.next();
            if (r.done) return;
          }
        } catch {
          /* closed underneath us — fine */
        }
      })(),
    );
  }

  // Wait until the producer is actually publishing before we start racing.
  {
    const warm = tracker[Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) {
      const r = await warm.next();
      if (r.done) break;
    }
    await warm.return?.();
  }
  console.error("  [phase] producer live — starting churn");

  // Churn: subscribe → consume a couple items → close, WHILE the producer fans
  // out at full rate over the wide pumped subscriber set. Each close() is the
  // cross-thread unsubscribe=true path — pre-fix, this wedges the JS thread.
  //
  // Two amplifiers make the pre-fix deadlock near-certain instead of rare:
  //  - Concurrency: many workers keep closes continuously in flight.
  //  - Phase decorrelation: a `setImmediate` yield between the last consumed
  //    frame and the close breaks the anti-correlation whereby next() resolves
  //    exactly as the fan-out RELEASES the mutex (which would make close find it
  //    free). The yield lands the close at an arbitrary fan-out phase, so it
  //    routinely catches the stream mutex held.
  const WORKERS = 24;
  const TARGET_CLOSES = 6000;
  const yieldTick = () => new Promise<void>((r) => setImmediate(r));
  let closed = 0;
  const t0 = Date.now();
  const churn = async (): Promise<void> => {
    while (closed < TARGET_CLOSES) {
      const it = tracker[Symbol.asyncIterator]();
      await it.next();
      await it.next();
      await yieldTick(); // decorrelate the close from the just-resolved push
      await it.return?.(); // <-- pre-fix: wedges here, freezing this thread
      const n = ++closed;
      if ((n & 127) === 0) process.stderr.write(`\r  [phase] churned ${n}/${TARGET_CLOSES}`);
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, () => churn()));
  console.error("\n  [phase] churn workers joined — closing background subscribers");

  stopBg = true;
  let bgClosed = 0;
  for (const it of background) {
    try {
      await it.return?.();
    } catch {
      /* ignore */
    }
    if ((++bgClosed & 127) === 0)
      process.stderr.write(`\r  [phase] background closed ${bgClosed}/${BG}`);
  }
  console.error(`\n  [phase] background closed ${bgClosed}/${BG} — settling pumps`);
  await Promise.allSettled(pumps);
  console.error("  [phase] pumps settled — releasing tracker");
  tracker.release();
  console.error("  [phase] tracker released — releasing camera");
  camera.release?.();
  console.error("  [phase] camera released — cleanup");
  cleanup();
  console.log(
    `\n36-stream-close-deadlock: PASS — churned ${closed} ` +
      `subscribe→consume→close cycles across ${WORKERS} workers against a ` +
      `full-rate producer with ${BG} concurrent subscribers in ` +
      `${Date.now() - t0}ms; no deadlock.`,
  );
}
