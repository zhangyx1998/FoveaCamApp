// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Camera-enumeration PROBE (disposable-orchestrator ruling 3). A small
// persistent utilityProcess main forks ONCE at startup — separate from any app
// instance — whose ONLY job is to load `core`, enumerate connected devices on
// an interval (~2s), and post the plain list to main, which forwards it to the
// status-only Welcome window. It NEVER opens a camera (only `Camera.list()`,
// which constructs + immediately releases handles), so it holds no hardware,
// gates nothing, outlives every app instance, and is restarted by main if it
// dies / killed at quit.
//
// It is its OWN tiny entry (not the orchestrator binary in a flag-mode) so it
// pulls in none of the session graph / Hub / pipe broker — just `core/Aravis`
// plus a cheap store-hub read for saved roles. Main PAUSES it while a hardware
// app instance is alive (Aravis is per-process exclusive — a background
// `Camera.list()` must not contend with the app's exclusive acquisition), and
// RESUMES it back at the Welcome screen.

import { getCameraKey } from "@lib/camera-config";
import { read } from "./store-hub.js";
import { cameraListChanged, type ProbeCamera } from "@lib/orchestrator/probe.js";

const INTERVAL_MS = 2000;

let paused = false;
let inFlight = false;
let last: ProbeCamera[] = [];

/** Read a saved role for a device without opening it — cheap store-hub read
 *  (vendor/model/serial only). Omitted (undefined) if none is stored. */
async function roleOf(info: { vendor: string; model: string; serial: string }): Promise<string | undefined> {
  try {
    const cfg = await read<{ role?: string }>(["cameras", getCameraKey(info)], {});
    return cfg.role;
  } catch {
    return undefined;
  }
}

/** Enumerate connected cameras as plain info, ALWAYS releasing the native
 *  handles (never a lease / stream). Roles come from saved config. */
async function enumerate(): Promise<ProbeCamera[]> {
  const { Camera } = await import("core/Aravis");
  const cameras = await Camera.list();
  try {
    const out: ProbeCamera[] = [];
    for (const c of cameras) {
      const info = { vendor: c.vendor, model: c.model, serial: c.serial };
      out.push({ ...info, role: await roleOf(info) });
    }
    return out;
  } finally {
    for (const c of cameras) {
      try {
        c.release();
      } catch {
        /* best-effort — never keep a handle */
      }
    }
  }
}

async function tick(): Promise<void> {
  if (paused || inFlight) return;
  inFlight = true;
  try {
    const cameras = await enumerate();
    // Only post on a real change (identity or displayed fields) — a 2s tick
    // that found nothing new is silent, no needless Welcome churn.
    if (cameraListChanged(last, cameras)) {
      last = cameras;
      try {
        process.parentPort.postMessage({ type: "probe:cameras", cameras });
      } catch {
        /* parent may be gone */
      }
    }
  } catch (e) {
    console.error("[probe] enumerate failed:", e);
  } finally {
    inFlight = false;
  }
}

process.parentPort.on("message", (e) => {
  const data = e.data as { type?: string } | null;
  if (data?.type === "probe:pause") {
    paused = true;
    last = []; // force a fresh post on resume
  } else if (data?.type === "probe:resume") {
    paused = false;
    void tick(); // enumerate immediately so Welcome updates without a 2s wait
  }
});

// Fire once at startup, then on the interval.
void tick();
setInterval(() => void tick(), INTERVAL_MS);
