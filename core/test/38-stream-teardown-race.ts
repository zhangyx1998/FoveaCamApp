// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Guard for the destroyed-mutex TEARDOWN race (core/lib/Stream/Stream.h):
// "mutex lock failed: Invalid argument" (exit 6) during a SIGTERM'd
// orchestrator teardown.
//
//   Subscriber::close(unsubscribe=true) captures a raw Stream* under its state
//   guard, RELEASES the guard, then locks stream->mutex in unsubscribe(). If a
//   clean shutdown leaves subscribers' back-pointers intact and the owning
//   brick's ~Stream frees that mutex in the gap, close() locks a DESTROYED
//   std::mutex — macOS libc++ reports EINVAL -> system_error -> thrown from the
//   noexcept ~Subscriber -> std::terminate (exit 6).
//
// Ordering invariant (Stream::shutdown -> eject_all_and_drain + the
// closes_in_flight_ gate): before ~Stream frees the mutex, every remaining
// subscriber's back-pointer is nulled and any close() already in flight toward
// unsubscribe() is drained. A later close() sees a dead stream and skips
// unsubscribe entirely.
//
// This is HARDWARE-FREE by design: it drives the native `__streamTeardownRace-
// SelfTest`, which churns Stream destruction against concurrent Subscriber
// closes with NO camera / ClockCalibrator in the picture — so the only thing
// under test is the Stream teardown ordering. A crash aborts the child; a hang
// (should the drain ever wedge) is caught by the out-of-process SIGKILL watchdog
// (a wedged native call would freeze the JS thread, so an in-process timer could
// never fire — same rationale as test 36).
//
// Run UNSANDBOXED from the repo root:
//   /opt/homebrew/bin/node core/test/38-stream-teardown-race.ts

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const IS_CHILD = process.env.__STREAM_TEARDOWN_CHILD__ === "1";
// Generous: a healthy run finishes in a few seconds; a wedged drain never exits.
const WATCHDOG_MS = 45_000;

// Soak size. Each iteration overlaps one ~Stream against `CLOSERS` cross-thread
// closes (plus the park/unpark of the stream's own thread). Pre-fix the
// destroyed-mutex abort bites within a handful of iterations; the count is sized
// to also comfortably cover the rarer (~1-in-10k) lost-wakeup teardown hang the
// fix closes, while finishing in a few seconds (well under the watchdog).
const ITERATIONS = 30000;
const CLOSERS = 6;

if (!IS_CHILD) {
  // ---- Parent: run the stress child under an out-of-process watchdog --------
  const child = spawn(process.execPath, [SELF], {
    env: { ...process.env, __STREAM_TEARDOWN_CHILD__: "1" },
    stdio: "inherit",
  });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    console.error(
      `\n38-stream-teardown-race: FAIL — the stress child did not finish ` +
        `within ${WATCHDOG_MS}ms; the teardown drain is wedged. Sending SIGKILL.`,
    );
    child.kill("SIGKILL");
  }, WATCHDOG_MS);
  timer.unref();
  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (killed) process.exit(1);
    if (signal) {
      console.error(
        `38-stream-teardown-race: FAIL — child killed by ${signal} ` +
          `(destroyed-mutex teardown race reproduced).`,
      );
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    console.error("38-stream-teardown-race: FAIL — could not spawn child:", err);
    process.exit(1);
  });
} else {
  await runStress();
}

async function runStress(): Promise<void> {
  const assert = (await import("node:assert/strict")).default;
  // The teardown-race self-test is a ROOT addon export (not in the loader's
  // named-export list), so reach it through the default export (the raw addon).
  const mod = (await import("core")) as any;
  const core = mod.default ?? mod;
  const selfTest = core.__streamTeardownRaceSelfTest;
  assert(
    typeof selfTest === "function",
    "core.__streamTeardownRaceSelfTest is exported",
  );

  const t0 = Date.now();
  // Synchronous native churn: spawns the destroyer + closer threads internally
  // and joins them. Pre-fix this aborts the process; post-fix it returns clean.
  const done = selfTest(ITERATIONS, CLOSERS);
  assert.equal(done, ITERATIONS, "all iterations completed");

  core.cleanup();
  console.log(
    `\n38-stream-teardown-race: PASS — ${ITERATIONS} teardown iterations, each ` +
      `overlapping ~Stream against ${CLOSERS} concurrent Subscriber closes, in ` +
      `${Date.now() - t0}ms; no destroyed-mutex abort, no wedge.`,
  );
}
