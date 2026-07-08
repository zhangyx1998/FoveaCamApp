// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Hardware janitor — a one-shot utilityProcess the MAIN process forks whenever
// the orchestrator dies without confirming quiescence (crash, abort, kill) and
// on final app quit. Its whole job is the hardware-safety invariant: the MEMS
// controller must never stay energized and no camera may stay
// streaming/locked after the process that armed them is gone. In-process
// handlers cannot cover a SIGABRT/SIGSEGV — this runs in a fresh process, so
// it works no matter how the orchestrator died (devices are claimed
// per-process; a dead owner's claims are already released by the OS).
//
// Deliberately minimal and forgiving: every step is best-effort with its own
// try/catch, the process always exits 0 (main only logs the outcome), and a
// global deadline guards against a wedged serial port or camera enumeration.

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

void (async () => {
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
  log("done");
  process.exit(0);
})();
