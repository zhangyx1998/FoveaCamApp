// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Hardware janitor — the single hardware-safety codebase, run in TWO modes:
//
//  1. ONE-SHOT (default): a utilityProcess the MAIN process forks whenever the
//     orchestrator dies without confirming quiescence (crash, abort, kill) and
//     on final app quit. In-process handlers cannot cover a SIGABRT/SIGSEGV —
//     this runs in a fresh process, so it works no matter how the orchestrator
//     died (devices are claimed per-process; a dead owner's claims are already
//     released by the OS).
//
//  2. WATCHDOG (FOVEA_JANITOR_MODE=watchdog): a DETACHED process main spawns
//     early (via ELECTRON_RUN_AS_NODE so it outlives main) to cover main's OWN
//     hard crash — the one path mode 1 cannot, since its spawner would be dead.
//     It polls main's liveness against a per-main-pid state file
//     (FOVEA_WATCHDOG_STATE). Clean shutdown ⇒ main deletes the file first
//     (stand-down). Main gone with the file still present ⇒ crash: wait for the
//     orphaned orchestrator to be reaped (kill it if it lingers so its device
//     claims free), then run the SAME quiescence as mode 1. See main.ts's
//     "Main-crash watchdog" header for the process tree.
//
// Its whole job is the hardware-safety invariant: the MEMS controller must
// never stay energized and no camera may stay streaming/locked after the
// process that armed them is gone.
//
// Deliberately minimal and forgiving: every step is best-effort with its own
// try/catch, the process always exits 0 (main only logs the outcome), and a
// global deadline guards against a wedged serial port or camera enumeration.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { SerialPort } from "serialport";
import { controller } from "@lib/orchestrator/contracts";

const DEADLINE_MS = 8000;
const log = (msg: string): void => console.log(`[janitor] ${msg}`);
const warn = (msg: string, e: unknown): void =>
  console.warn(`[janitor] ${msg}:`, e instanceof Error ? e.message : e);

async function disableMems(): Promise<void> {
  const { Device, Protocol } = await import("core/Controller");
  // Same match the controller session uses on connect: the contract's default
  // vendor/product ids (a UI override is per-boot state that died with the
  // orchestrator — the defaults are the persistent source of truth).
  const { vendorId, productId } = controller.state;
  const ports = await SerialPort.list();
  const info = ports.find(
    (p) => p.vendorId === vendorId && p.productId === productId,
  );
  if (!info) {
    log("no MEMS controller port found — nothing to disable");
    return;
  }
  const device = new Device(info.path);
  try {
    await device.verifyVersion();
    await device.set(Protocol.System.Enable, false);
    log(`MEMS disabled on ${info.path}`);
  } finally {
    device.release();
  }
}

async function quiesceCameras(): Promise<void> {
  const { Camera } = await import("core/Aravis");
  const cameras = await Camera.list();
  if (cameras.length === 0) {
    log("no cameras found — nothing to stop");
    return;
  }
  for (const camera of cameras) {
    const serial = (() => {
      try {
        return camera.serial;
      } catch {
        return "<unknown>";
      }
    })();
    try {
      // AcquisitionStop + TLParamsLocked=0 (Aravis order). Also clears the
      // lock a crashed owner left behind, which otherwise rejects the next
      // boot's config restore with USB3Vision access-denied.
      camera.stopAcquisition();
      log(`camera ${serial}: acquisition stopped`);
    } catch (e) {
      warn(`camera ${serial}: stopAcquisition failed`, e);
    }
    try {
      camera.release();
    } catch (e) {
      warn(`camera ${serial}: release failed`, e);
    }
  }
}

async function run(): Promise<void> {
  try {
    await disableMems();
  } catch (e) {
    warn("MEMS disable failed", e);
  }
  try {
    await quiesceCameras();
  } catch (e) {
    warn("camera quiescence failed", e);
  }
}

/** The whole hardware-safety action (both modes): disable MEMS + stop cameras,
 *  bounded by DEADLINE_MS, then release the native module's per-env contexts. */
async function quiesceAll(): Promise<void> {
  const deadline = new Promise<void>((r) => {
    setTimeout(() => {
      console.error(`[janitor] deadline (${DEADLINE_MS}ms) hit — exiting`);
      r();
    }, DEADLINE_MS);
  });
  await Promise.race([run(), deadline]);
  // Release the native module's per-env contexts NOW, while statics are
  // alive — leaving it to process.exit teardown runs the same hooks after
  // static mutex destruction and spams "[Cleanup] … mutex lock failed:
  // Invalid argument" (harmless but reads like a crash; rig 2026-07-08).
  try {
    const { cleanup } = await import("core");
    cleanup();
  } catch {
    // core may not have loaded at all (nothing to clean).
  }
}

// ---- Watchdog mode (main-crash coverage) ----------------------------------

const WATCHDOG_POLL_MS = 500;
const ORPHAN_WAIT_MS = 5000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Liveness probe. `kill(pid, 0)` throws ESRCH when the pid is gone; EPERM
 *  means it exists but we can't signal it (still alive). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WatchdogState {
  mainPid: number;
  /** Live orchestrator instance pids (disposable model, ruling 5: 0..N alive).
   *  `orchestratorPid` is the legacy single-pid field, still read for
   *  backward-compat with a state file written by an older main. */
  orchestratorPids?: number[];
  orchestratorPid?: number | null;
}
function readState(statePath: string): WatchdogState | null {
  try {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, "utf8")) as WatchdogState;
  } catch {
    return null; // mid-write / malformed — treat as absent, re-read next tick
  }
}

/** Wait for the orphaned orchestrator to be reaped so its per-process device
 *  claims free; force-kill it if it lingers past the deadline. */
async function waitForOrphanGone(pid: number): Promise<void> {
  const start = Date.now();
  while (pidAlive(pid) && Date.now() - start < ORPHAN_WAIT_MS) await sleep(200);
  if (pidAlive(pid)) {
    log(`orphaned orchestrator ${pid} still alive past ${ORPHAN_WAIT_MS}ms — killing`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await sleep(500); // let the OS release its device handles
  }
}

async function runWatchdog(): Promise<void> {
  const statePath = process.env.FOVEA_WATCHDOG_STATE;
  const mainPid = Number(process.env.FOVEA_MAIN_PID);
  if (!statePath || !Number.isFinite(mainPid)) {
    console.error("[janitor] watchdog: missing FOVEA_WATCHDOG_STATE / FOVEA_MAIN_PID");
    return;
  }
  log(`watchdog armed (main pid ${mainPid})`);
  for (;;) {
    // Stand-down: main deleted the file (clean shutdown) — nothing to guard.
    if (!readState(statePath)) {
      log("watchdog stand-down (state file gone) — exiting");
      return;
    }
    if (!pidAlive(mainPid)) {
      // Main is gone. Re-check the file once to resolve the clean-shutdown race
      // (main deletes the file JUST before it dies — the delete may land after
      // we observe the dead pid).
      await sleep(200);
      const state = readState(statePath);
      if (!state) {
        log("watchdog: main exited cleanly — exiting");
        return;
      }
      // CRASH: main died with the state file still present → enforce quiescence.
      log("watchdog: main crashed (state file present) — enforcing quiescence");
      // Wait for EVERY live orchestrator instance to be reaped so their
      // per-process device claims free (disposable model: 0..N alive). Falls
      // back to the legacy single-pid field for an older state file.
      const pids =
        state.orchestratorPids ??
        (typeof state.orchestratorPid === "number" ? [state.orchestratorPid] : []);
      for (const pid of pids) await waitForOrphanGone(pid);
      await quiesceAll();
      try {
        unlinkSync(statePath);
      } catch {
        /* best-effort */
      }
      log("watchdog quiescence complete");
      return;
    }
    await sleep(WATCHDOG_POLL_MS);
  }
}

void (async () => {
  if (process.env.FOVEA_JANITOR_MODE === "watchdog") {
    await runWatchdog();
  } else {
    await quiesceAll();
    log("done");
  }
  process.exit(0);
})();
