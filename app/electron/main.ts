// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  shell,
  ipcMain,
  utilityProcess,
  webContents,
  MessageChannelMain,
  type UtilityProcess,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import {
  classifyOrchestratorExit,
  shouldRunJanitor,
} from "./orchestrator-exit";
import { ViewerEngineManager, type EngineHandle } from "./viewer-engine";
import { getIcon } from "./util";
import { resolveDefaultSavePath, validateWritablePath } from "@lib/util/fs";
import {
  WindowManager,
  type ManagedWindow,
  type WindowDescriptor,
} from "./window-manager";
import {
  consumeManifest,
  planFromManifest,
  saveManifest,
} from "./window-manifest";
import { APPS, appById, WINDOWS, type AppMeta } from "@lib/windows";
import type { InvokeChannels, PushChannels, SendChannels } from "./bridge";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = app.getPath("userData");

// The built directory structure
//
// ├─┬ .dist/electron
// │ ├── main.js / orchestrator.js / preload-*.cjs
// ├─┬ .dist/renderer
// │ └── windows/*.html      (multi-window entries, docs/history/refactor/multi-window.md;
// │                          the legacy index.html was removed in round 2)
//
const DIST = path.join(DIR, "..");
process.env.APP_ROOT = path.join(DIR, "../..");

export const MAIN_DIST = path.join(DIST, "electron");
export const RENDERER_DIST = path.join(DIST, "renderer");
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const IS_DEV = !!VITE_DEV_SERVER_URL;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

// Disable Chromium's Graphite (Skia's new raster backend, default-on in this
// Electron's Chromium): under our sustained many-canvas putImageData load
// (disparity-scope paints ~7 full-rate views) it dies after minutes with
// "Graphite insertRecording failed with status 5" → GPU process exit_code=5
// (rig 2026-07-09 00:41). Ganesh (the fallback) carries the same load
// stably. Must be appended BEFORE app ready. Revisit on Electron upgrades —
// Graphite may stabilize, and this line then deserves an A/B on the rig.
app.commandLine.appendSwitch("disable-features", "SkiaGraphite");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const preload = {
  renderer: path.join(DIR, "preload-renderer.cjs"),
  profiler: path.join(DIR, "preload-profiler.cjs"),
  // Standalone viewer (standalone-viewer-and-fcap ruling 1): bridge + the
  // in-window playback worker; no shm reader, no orchestrator port.
  viewer: path.join(DIR, "preload-viewer.cjs"),
};

function customizeApp() {
  app.setName("FoveaCam Duo");
  // Application menu WITHOUT the reload role: plain Ctrl/Cmd-R is reserved
  // for the recorder trigger in every mode (multi-window.md req. 6) — the
  // default menu's View→Reload/Force-Reload accelerators would bypass the
  // per-window `before-input-event` interception below.
  // Direct app-switch affordance (A-13, adopted default): an "Apps" submenu
  // over the `lib/windows.ts` catalog. Selecting an app routes through the
  // window manager's existing openApp drain/switch flow — exclusivity, the
  // busy-refusal prompt, and welcome-close all apply unchanged. Being the
  // application-level menu, every window class (welcome/app/profiler/
  // projection) gets it for free.
  const appItem = (a: AppMeta): Electron.MenuItemConstructorOptions => ({
    label: a.title,
    click: () => void manager.openApp(a.id),
  });
  const launchable = APPS.filter((a) => !a.dev || IS_DEV);
  const appsMenu: Electron.MenuItemConstructorOptions = {
    label: "Apps",
    submenu: [
      ...launchable.filter((a) => a.group === "application").map(appItem),
      { type: "separator" },
      ...launchable.filter((a) => a.group === "calibration").map(appItem),
      { type: "separator" },
      ...launchable.filter((a) => a.group === "utility").map(appItem),
    ],
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        // A-11: open a `.fovea` recording in a viewer window (one per file).
        {
          label: "Open Recording…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openRecordingDialog(),
        },
        { type: "separator" },
        // OS-standard close-window shortcut — the custom menu previously had
        // no Close item, so Cmd/Ctrl-W was dead. Routes through win.close()
        // like the traffic light (welcome respawn / owner-close unchanged).
        { role: "close", accelerator: "CmdOrCtrl+W" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(IS_DEV ? [{ role: "toggleDevTools" as const }] : []),
        { role: "togglefullscreen" as const },
      ],
    },
    appsMenu,
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Recording container extensions the app opens (standalone-viewer-and-fcap
// ruling 2): `.fcap` is what the recorder writes now; `.fovea` stays accepted
// as a READ-ONLY legacy so existing rig recordings still open. The dialog filter,
// macOS `open-file`, and the Windows/Linux `second-instance` arg association all
// derive from this one list.
const RECORDING_EXTENSIONS = ["fcap", "fovea"] as const;
const isRecordingPath = (p: string): boolean =>
  RECORDING_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(`.${ext}`));

/** File→Open Recording… (A-11): `.fcap`/`.fovea` filter, one viewer window per
 *  file (a re-open of an already-viewed file focuses its window). */
async function openRecordingDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: "Open Recording",
    filters: [
      { name: "FoveaCam Recording", extensions: [...RECORDING_EXTENSIONS] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return;
  for (const p of result.filePaths) manager.openViewer(p);
}

// Typed `ipcMain` wrappers over the shared channel registry (bridge.ts) — the
// main-side counterpart to preload-bridge.ts's `invoke`/`send`/`listen`. A bad
// channel name or handler arg/return shape is a compile error, so the two ends
// of every bridge channel can't drift.
function handle<K extends keyof InvokeChannels>(
  channel: K,
  fn: (
    ...args: InvokeChannels[K]["args"]
  ) => InvokeChannels[K]["ret"] | Promise<InvokeChannels[K]["ret"]>,
): void {
  ipcMain.handle(channel, (_e, ...args) => fn(...(args as InvokeChannels[K]["args"])));
}
function onRenderer<K extends keyof SendChannels>(
  channel: K,
  fn: (...args: SendChannels[K]) => void,
): void {
  ipcMain.on(channel, (_e, ...args) => fn(...(args as SendChannels[K])));
}
function pushTo<K extends keyof PushChannels>(
  wc: Electron.WebContents,
  channel: K,
  ...args: PushChannels[K]
): void {
  wc.send(channel, ...args);
}

// ---- Renderer bridge handlers (docs/history/refactor/orchestrator.md §7.1 T5) -----
// The renderer's `SavePath`/`SaveControls`/`RecordControls` used to call
// `node:path`/`node:fs`/`node:os` directly — reachable only under the old
// `nodeIntegration: true`. These mirror that logic here so `foveaBridge`
// (preload-bridge.ts) can forward to it over IPC instead.
handle("save-path:resolve", (segments) => path.resolve(...segments));
handle("save-path:resolve-default", (directory) => resolveDefaultSavePath(directory));
handle("fs:exists", (p) => existsSync(p));
handle("fs:validate-writable", (p) => validateWritablePath(p));
handle("perf-snapshot:write", async (content) => {
  const dir = path.join(DATA, "perf-snapshots");
  await mkdir(dir, { recursive: true });
  const file = path.join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  await writeFile(file, content);
  console.log(`[perf] snapshot written: ${file}`);
  return file;
});

// Reveal the perf-snapshots folder in the OS file browser (Finder/Explorer).
handle("perf-snapshot:open-folder", async () => {
  const dir = path.join(DATA, "perf-snapshots");
  await mkdir(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) console.error(`[perf] openPath failed for ${dir}: ${err}`);
  else console.log(`[perf] revealed snapshot folder: ${dir}`);
  return dir;
});

// Reveal ONE written snapshot file (selects it in Finder/Explorer). Accepts
// only paths inside the perf-snapshots dir — keep the bridge surface narrow.
handle("perf-snapshot:reveal", (file) => {
  const dir = path.join(DATA, "perf-snapshots");
  if (!path.resolve(file).startsWith(dir + path.sep)) return;
  shell.showItemInFolder(file);
});

// Reveal a recording container in Finder/Explorer (selects the file) — the
// viewer window's "Open folder" button (standalone-viewer-and-fcap UX 5).
handle("viewer:reveal", (file) => {
  if (typeof file === "string" && file) shell.showItemInFolder(file);
});

// ---- Orchestrator process -------------------------------------------------
// A utilityProcess that owns `core` (cameras, vision, control, hardware I/O).
// Its event loop is independent of any renderer's render loop. Main only brokers
// a direct MessagePort between each renderer and the orchestrator; frames and
// commands then flow point-to-point without routing through here. The only
// main↔orchestrator control traffic is the window-switch drain handshake below.
let orchestrator: UtilityProcess | null = null;
let drainSeq = 0;
const pendingDrains = new Map<
  number,
  (result: { ok: boolean; reason?: string }) => void
>();

// ---- Hardware janitor (safety invariant, docs/hardware/stage-f.md) --------
// The orchestrator confirms `quiesced` (MEMS disabled + cameras released)
// before a graceful exit. If it EVER exits without that confirmation —
// SIGABRT from native code, SIGSEGV, OOM kill — the armed hardware outlives
// it, so main forks this one-shot cleanup process (orchestrator/janitor.ts):
// fresh process, fresh device claims, disables the MEMS controller over
// serial and stops every camera's acquisition (which also clears
// TLParamsLocked, unblocking the next boot's config restore).
// The `quiesced` clean-exit ACK (ruling 3/4): flipped when the orchestrator
// confirms hardware is parked, BEFORE it stops. Authoritative for the
// clean-vs-crash decision — never the exit code.
let orchestratorQuiesced = false;
// Did MAIN initiate this orchestrator's termination (quit / dev-restart)? Lets
// a missing ack read as "killed" (expected) vs "crash" (unexpected). Reset in
// startOrchestrator.
let orchestratorExpectedExit = false;
// Resolvers waiting on the next `quiesced` ack (the quit/dev-restart paths).
let ackWaiters: Array<() => void> = [];
/** Resolve `true` once the orchestrator posts `quiesced`, or `false` at the
 *  bounded deadline (a hung quiesce still lets the app quit → classified
 *  "killed"). */
function waitForQuiesceAck(timeoutMs: number): Promise<boolean> {
  if (orchestratorQuiesced) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      ackWaiters = ackWaiters.filter((w) => w !== onAck);
      resolve(false);
    }, timeoutMs);
    const onAck = () => {
      clearTimeout(timer);
      resolve(true);
    };
    ackWaiters.push(onAck);
  });
}

// One janitor run covers everything armed by the dead orchestrator — dedupe
// concurrent triggers (unexpected-exit handler racing the quit path).
let janitorRun: Promise<void> | null = null;
function ensureJanitor(reason: string): Promise<void> {
  janitorRun ??= runJanitor(reason).finally(() => {
    janitorRun = null;
  });
  return janitorRun;
}
function runJanitor(reason: string): Promise<void> {
  console.warn(`[janitor] launching (${reason})`);
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(path.join(DIR, "janitor.js"), [], {
      stdio: "inherit",
      env: { ...process.env, FOVEA_DATA_PATH: DATA },
    });
    const timer = setTimeout(() => {
      console.error("[janitor] timed out — killing");
      proc.kill();
    }, 10_000);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---- Main-crash watchdog (safety invariant gap 1) -------------------------
// PROCESS TREE (why a detached process, not a utilityProcess child):
//
//   OS
//   ├─ main (Electron)            spawns ↓ once, detached, at startup
//   │   ├─ orchestrator  (utilityProcess.fork — dies WITH main, no quiesce)
//   │   └─ janitor       (utilityProcess.fork — one-shot, on orch death)
//   └─ watchdog (detached, ELECTRON_RUN_AS_NODE — OUTLIVES main)
//
// The janitor above is forked BY main, so main's OWN hard crash (SIGKILL /
// SIGSEGV) reaps the orchestrator with NOTHING left to disarm the MEMS mirrors
// (releasing a serial port does not de-energize them). The watchdog closes that
// hole: a detached sibling that reads a per-main-pid state file and polls
// main's liveness. On a CLEAN shutdown main deletes the file first (stand-down
// = the file is gone). If main dies while the file still exists, the watchdog
// waits for the orphaned orchestrator to be reaped (killing it if it lingers so
// its device claims free), then runs the SAME quiescence as the janitor, and
// exits. It never keeps the app open (detached + unref'd), never fights the
// normal janitor path (that path only runs while main is ALIVE; the watchdog
// acts only after main is GONE), and exits quietly on stand-down.
//
// Implemented as janitor.js in FOVEA_JANITOR_MODE=watchdog so there is exactly
// one hardware-quiescence codebase.
const watchdogStatePath = path.join(DATA, `watchdog-${process.pid}.json`);
let watchdogSpawned = false;

/** (Re)write this main instance's watchdog state file — mainPid is fixed;
 *  orchestratorPid is refreshed on every (re)spawn so the watchdog can wait on
 *  the CURRENT orphan before quiescing. */
function writeWatchdogState(): void {
  try {
    writeFileSync(
      watchdogStatePath,
      JSON.stringify({
        mainPid: process.pid,
        orchestratorPid: orchestrator?.pid ?? null,
      }),
    );
  } catch (e) {
    console.error("[watchdog] state write failed:", e);
  }
}

/** Spawn the detached watchdog ONCE, at orchestrator-spawn time. */
function spawnWatchdog(): void {
  if (watchdogSpawned) return;
  watchdogSpawned = true;
  writeWatchdogState();
  try {
    const wd = spawn(process.execPath, [path.join(DIR, "janitor.js")], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        // Run the Electron binary as plain Node (no window/dock) so the
        // watchdog survives main and can still load the native `core` addon.
        ELECTRON_RUN_AS_NODE: "1",
        FOVEA_JANITOR_MODE: "watchdog",
        FOVEA_WATCHDOG_STATE: watchdogStatePath,
        FOVEA_MAIN_PID: String(process.pid),
        FOVEA_DATA_PATH: DATA,
      },
    });
    wd.unref();
  } catch (e) {
    console.error("[watchdog] spawn failed:", e);
    watchdogSpawned = false;
  }
}

/** Clean-shutdown stand-down: delete this instance's state file so the watchdog
 *  exits quietly instead of quiescing. Synchronous — must complete before main
 *  exits. */
function standDownWatchdog(): void {
  try {
    unlinkSync(watchdogStatePath);
  } catch {
    /* already gone (or never created) */
  }
}

/** Best-effort sweep of watchdog state files left by a dead main whose watchdog
 *  also died before cleaning up (double-fault) — keeps the data dir tidy. */
function sweepStaleWatchdogState(): void {
  try {
    for (const f of readdirSync(DATA)) {
      const m = /^watchdog-(\d+)\.json$/.exec(f);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === process.pid) continue;
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "EPERM";
        }
      })();
      if (!alive) unlinkSync(path.join(DATA, f));
    }
  } catch {
    /* best-effort */
  }
}

const delay = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
/** Poll `pred` until true or the deadline lapses (bounded quit waits). */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) await delay(50);
}

function startOrchestrator() {
  const entry = path.join(DIR, "orchestrator.js");
  orchestratorQuiesced = false;
  orchestratorExpectedExit = false;
  orchestrator = utilityProcess.fork(entry, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      // The orchestrator reads/writes the same config store as the renderer.
      FOVEA_DATA_PATH: DATA,
      // Boot-span baseline (docs/history/refactor/orchestrator.md §7.1 S5) — stamped
      // as close to `fork()` as possible so `index.ts` can measure fork ->
      // first-useful-work timing.
      FOVEA_FORK_TS: String(Date.now()),
    },
  });
  // The watchdog needs the CURRENT orchestrator pid to wait on the right orphan
  // after a main crash. `pid` is populated once the child has spawned.
  orchestrator.on("spawn", () => writeWatchdogState());
  orchestrator.on("message", (data: unknown) => {
    const msg = data as {
      type?: string;
      id?: number;
      ok?: boolean;
      reason?: string;
      path?: string;
    };
    if (msg?.type === "quiesced") {
      // The authoritative clean-exit ack (ruling 3/4): record it and release
      // any quit/dev-restart path waiting on it.
      orchestratorQuiesced = true;
      for (const w of ackWaiters.splice(0)) w();
      return;
    }
    // Phase 5 auto-open (capture-recorder-nodes.md ruling 8): the recorder
    // node finalized a recording container — surface it in a STANDALONE
    // viewer window without user action (one window per file via fileKey
    // dedupe, so a re-finalize just focuses it; the window does its own
    // playback — standalone-viewer-and-fcap ruling 1).
    //
    // ── SEAM (recorder wave, orchestrator-side; NOT in this wave's scope) ──
    // The SEND side belongs in `orchestrator/recorder-node.ts`'s stopRecording
    // finalize path (Phase 2). One line, mirroring the `quiesced` /
    // `window:drain-result` posts in `orchestrator/index.ts`:
    //     process.parentPort.postMessage({ type: "recording:finished", path });
    // where `path` is the just-closed container path. No renderer bridge is
    // involved — recording runs orchestrator-side, so it flows
    // orchestrator → MAIN directly (this handler), not renderer → main.
    if (msg?.type === "recording:finished") {
      if (typeof msg.path === "string" && msg.path) manager.openViewer(msg.path);
      return;
    }
    if (msg?.type !== "window:drain-result" || msg.id === undefined) return;
    pendingDrains.get(msg.id)?.({ ok: !!msg.ok, reason: msg.reason });
    pendingDrains.delete(msg.id);
  });
  orchestrator.on("exit", (code) => {
    console.warn("Orchestrator exited:", code);
    orchestrator = null;
    // Ack-based classification (ruling 4): ack present ⇒ clean (code ignored);
    // absent + main-initiated ⇒ killed; absent + unexpected ⇒ crash.
    const report = classifyOrchestratorExit({
      acked: orchestratorQuiesced,
      expected: orchestratorExpectedExit,
      code: code ?? null,
    });
    // Safety invariant: any non-clean exit may have left the MEMS controller /
    // cameras armed — quiesce out-of-process. (A clean exit already did so
    // in-process and posted the ack.)
    if (shouldRunJanitor(report))
      void ensureJanitor(`orchestrator ${report.reason} (code ${code})`);
    // A dead orchestrator has nothing left to drain — unblock any switch
    // waiting on it rather than letting it time out.
    for (const [id, resolve] of pendingDrains) {
      resolve({ ok: true });
      pendingDrains.delete(id);
    }
    // Every renderer's pending orchestrator requests would otherwise hang
    // forever (the crashed process can't reply) — notify them to reject
    // in-flight calls AND surface the crash report to the associated windows
    // (client.ts scopes it to windows that actually connected). See
    // docs/history/refactor/orchestrator.md §12.1 C5.
    for (const w of BrowserWindow.getAllWindows())
      pushTo(w.webContents, "orchestrator:down", report);
  });
}

/** Ask the orchestrator to idle every camera-owning session and wait for the
 *  releases to settle (multi-window.md §3 — "closed" = session-idle-drained).
 *  `{ok: false}` = refused: a session is mid-capture/recording. */
function drainSessions(): Promise<{ ok: boolean; reason?: string }> {
  if (!orchestrator) return Promise.resolve({ ok: true }); // nothing to drain
  const id = ++drainSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // A wedged drain must not silently hand cameras to the next app —
      // surface it as a refusal so the user can retry (or restart).
      pendingDrains.delete(id);
      resolve({ ok: false, reason: "session drain timed out (10s)" });
    }, 10_000);
    pendingDrains.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    orchestrator!.postMessage({ type: "window:drain", id });
  });
}

// A-34: sender (webContents id) → stable windowId, maintained by spawnWindow.
// Lets the connect handshake below tag each channel with the window it
// belongs to — the orchestrator side keys per-window state (C-24 compose
// namespaces `win/<windowId>/...`) on it.
const windowIdBySender = new Map<number, string>();

// A renderer asks to connect; hand both ends of a fresh channel out. Already
// generic per-`event.sender` — every window class connecting just gets its
// own port pair (§7.1 S4 / multi-window per-window handshake). The handoff
// message carries the sender's stable windowId (A-34) so the Hub can tag the
// channel; null for a sender the manager doesn't know (shouldn't happen).
ipcMain.on("orchestrator:connect" satisfies keyof SendChannels, (event) => {
  if (!orchestrator) startOrchestrator();
  const { port1, port2 } = new MessageChannelMain();
  const windowId = windowIdBySender.get(event.sender.id) ?? null;
  orchestrator!.postMessage({ type: "channel:connect", windowId }, [port1]);
  event.sender.postMessage("orchestrator:port", null, [port2]);
});

// Sender-scoped pin toggle (the profiler nav bar): keep THIS window above all
// others. The renderer owns persistence (localStorage) and re-applies on mount.
ipcMain.on("window:set-pinned" satisfies keyof SendChannels, (event, pinned) => {
  BrowserWindow.fromWebContents(event.sender)?.setAlwaysOnTop(!!pinned);
});

// ---- Viewer playback engines (standalone-viewer-and-fcap, AS SHIPPED) ------
// One MAIN-owned utilityProcess per viewer window: the playback engine can't be
// a renderer worker (Electron renderers can't construct Node workers), so main
// forks it exactly like the orchestrator and brokers a MessagePort between the
// window and its engine. Main owns the lifecycle invariants — single-writer
// sidecar (one engine per file, keyed per window), terminate-before-respawn
// (dev full-reload), and flush-before-close (bounded grace) — in
// ViewerEngineManager; the Electron process/port wiring is injected here.
const VIEWER_ENGINE_ENTRY = path.join(DIR, "viewer-worker.js");

/** Fork + wire one viewer engine for the window `senderId`, over `file`. */
function createViewerEngine(senderId: number, file: string): EngineHandle {
  const wc = webContents.fromId(senderId) ?? null;
  const proc = utilityProcess.fork(VIEWER_ENGINE_ENTRY, [], {
    stdio: "inherit",
    env: { ...process.env, FOVEA_DATA_PATH: DATA },
  });
  const { port1, port2 } = new MessageChannelMain();
  // Hand port1 + the file to the engine (it opens eagerly), deliver port2 to the
  // window. Posting before "spawn" is fine — utilityProcess queues until the
  // child is up (same as the orchestrator connect handshake).
  proc.postMessage({ type: "init", file }, [port1]);
  if (wc && !wc.isDestroyed()) wc.postMessage("viewer:port", null, [port2]);

  let killed = false;
  const flushWaiters: Array<() => void> = [];
  proc.on("message", (data: unknown) => {
    if ((data as { type?: string })?.type === "flushed")
      for (const w of flushWaiters.splice(0)) w();
  });
  proc.on("exit", (code) => {
    if (killed) return; // expected teardown — the manager already dropped us
    // Unexpected engine death: drop the handle + tell the window to stop
    // waiting for frames (its crash surface).
    viewerEngines.forget(senderId);
    if (wc && !wc.isDestroyed())
      pushTo(wc, "viewer:engine-down", `Viewer engine exited unexpectedly (code ${code}).`);
  });

  return {
    requestFlush: () =>
      new Promise<void>((resolve) => {
        if (killed) return resolve();
        flushWaiters.push(resolve);
        proc.postMessage({ type: "close" }); // engine flushes sidecar → acks `flushed`
      }),
    kill: () => {
      killed = true;
      proc.kill();
    },
  };
}

const viewerEngines = new ViewerEngineManager({ graceMs: 500, create: createViewerEngine });

// A viewer window asks main to (re)fork its engine over `file`. Sender-scoped:
// the engine is keyed by the window's webContents id, and the window manager's
// one-window-per-file dedupe makes that one-engine-per-file transitively. A
// re-spawn (dev full-reload) terminates the previous engine first.
ipcMain.on("viewer:spawn" satisfies keyof SendChannels, (event, file) => {
  if (typeof file === "string" && file) void viewerEngines.spawn(event.sender.id, file);
});

// ---- Window manager (docs/history/refactor/multi-window.md §3) --------------------

function entryURL(desc: WindowDescriptor): { url?: string; file?: string; search?: string } {
  // A manifest-restored window lands on its persisted URL (carries the state
  // params, req. 7) — but only in dev, where the dev-server origin matches.
  if (desc.url && IS_DEV && desc.url.startsWith(VITE_DEV_SERVER_URL!))
    return { url: desc.url };
  // State-in-URL params (req. 7, e.g. a projection's `?session=…&frame=…`)
  // ride the query string in both modes: appended to the dev URL, passed as
  // `loadFile`'s `search` in a packaged build.
  if (IS_DEV)
    return { url: new URL(desc.entry + (desc.search ?? ""), VITE_DEV_SERVER_URL).href };
  return { file: path.join(RENDERER_DIST, desc.entry), search: desc.search };
}

// Pure metadata → BrowserWindow options adapter. The taxonomy facts (preload,
// sandbox, bounds, base title) live in the `WINDOWS` table (@lib/windows) so
// every window consumer derives from one source; only the Electron-specific
// chrome (hidden titlebar + overlay, icon, background) stays here.
function windowOptions(desc: WindowDescriptor): Electron.BrowserWindowConstructorOptions {
  // Shared chrome (A-7 / multi-window.md §3): every window class uses the
  // hidden titlebar + overlay so the one TitleBar component renders the
  // chrome consistently, profiler included (it previously had native chrome).
  const chrome: Electron.BrowserWindowConstructorOptions = {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#2f3241", symbolColor: "#74b1be", height: 40 },
    backgroundColor: "black",
    icon: getIcon("icon.ico"),
  };
  const spec = WINDOWS[desc.class];
  const { width, height, minWidth, minHeight } = spec.bounds;
  // App windows carry the app's own title; every other class uses the base.
  const title =
    desc.class === "app"
      ? `FoveaCam Duo — ${appById(desc.appId!)?.title ?? desc.appId}`
      : spec.title;
  return {
    ...chrome,
    title,
    width,
    height,
    ...(minWidth !== undefined ? { minWidth } : {}),
    ...(minHeight !== undefined ? { minHeight } : {}),
    webPreferences: {
      preload: preload[spec.preload],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: spec.sandbox,
    },
  };
}

function spawnWindow(desc: WindowDescriptor): ManagedWindow {
  const win = new BrowserWindow({
    ...windowOptions(desc),
    ...(desc.bounds ?? {}),
    // Switch inheritance: land in the same display state as the window this
    // one replaces (welcome↔app switches thread these through the manager).
    ...(desc.fullscreen ? { fullscreen: true } : {}),
  });
  if (desc.maximized && !desc.fullscreen) win.maximize();
  // App windows maximize by default (legacy behavior) unless restoring or
  // inheriting a specific display state.
  else if (desc.class === "app" && !desc.bounds && !desc.fullscreen) win.maximize();

  const target = entryURL(desc);
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file!, target.search ? { search: target.search } : undefined);

  // Make all links open with the browser, not with the application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });
  // Renderer-initiated reloads/navigation blocked in production (req. 6) —
  // the packaged windows never navigate legitimately. Dev keeps navigation
  // for the vite dev-server flows.
  if (!IS_DEV)
    win.webContents.on("will-navigate", (e) => e.preventDefault());

  // A-7: forward fullscreen transitions so the shared chrome can adjust
  // traffic-light inset + drag regions on BOTH edges (the old one-way bug).
  win.on("enter-full-screen", () => pushTo(win.webContents, "window:fullscreen", true));
  win.on("leave-full-screen", () => pushTo(win.webContents, "window:fullscreen", false));

  // Reload accelerator policy (req. 6), enforced per-window:
  //   plain Ctrl/Cmd-R  → recorder trigger stub, NEVER reload (all modes)
  //   Ctrl/Cmd-Shift-R  → dev only: full restart (main + orchestrator) with
  //                       window-layout restore; blocked in production.
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const mod = process.platform === "darwin" ? input.meta : input.control;
    if (!mod || input.key.toLowerCase() !== "r") return;
    event.preventDefault();
    if (input.shift) {
      if (IS_DEV) void devRestart();
    } else {
      // No-op stub — real semantics land with the recorder stage
      // (docs/history/refactor/recorder-container.md).
      pushTo(win.webContents, "recorder:trigger");
    }
  });

  // Last-known display state, refreshed at "close" (before destruction) — the
  // welcome rule respawns AFTER "closed", when the BrowserWindow can no longer
  // answer; this is what lets app→welcome inherit bounds + fullscreen.
  let lastDisplayState = {
    bounds: win.getBounds(),
    fullscreen: win.isFullScreen(),
    maximized: win.isMaximized(),
  };
  win.on("close", () => {
    lastDisplayState = {
      bounds: win.getBounds(),
      fullscreen: win.isFullScreen(),
      maximized: win.isMaximized(),
    };
  });

  const managed: ManagedWindow = {
    class: desc.class,
    appId: desc.appId,
    fileKey: desc.fileKey,
    owner: desc.owner, // WS2 2a: parent pointer (set by 2b's sub-window opener)
    key: desc.key, // WS2 2a: toggle dedupe key
    windowId: desc.windowId, // A-34: manager-minted stable instance id
    focus: () => {
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    close: () => win.close(),
    isDestroyed: () => win.isDestroyed(),
    getURL: () => win.webContents.getURL(),
    getBounds: () => (win.isDestroyed() ? lastDisplayState.bounds : win.getBounds()),
    isFullScreen: () =>
      win.isDestroyed() ? lastDisplayState.fullscreen : win.isFullScreen(),
    isMaximized: () =>
      win.isDestroyed() ? lastDisplayState.maximized : win.isMaximized(),
  };
  // A-34: sender→windowId lookup for the orchestrator channel handshake (the
  // connect IPC only knows `event.sender`), + the close-teardown signal C-24's
  // composition keys `win/<windowId>/...` namespaces on.
  if (desc.windowId) {
    const windowId = desc.windowId;
    const senderId = win.webContents.id; // captured now — webContents is gone by "closed"
    windowIdBySender.set(senderId, windowId);
    win.on("closed", () => {
      windowIdBySender.delete(senderId);
      orchestrator?.postMessage({ type: "window:closed", windowId });
    });
  }
  // Viewer windows: flush + kill this window's playback engine on close
  // (flush-before-close single-writer sidecar). Captured now — the webContents
  // is gone by "closed".
  if (desc.class === "viewer") {
    const engineKey = win.webContents.id;
    win.on("closed", () => void viewerEngines.close(engineKey));
  }
  win.on("closed", () => manager.onWindowClosed(managed));
  return managed;
}

const manager = new WindowManager({
  spawn: spawnWindow,
  drainSessions,
  notifyRefusal: (reason) => {
    void dialog.showMessageBox({
      type: "warning",
      title: "Cannot switch apps",
      message: "The current app is busy.",
      detail: `${reason}. Finish or stop it, then try again.`,
    });
  },
});

onRenderer("window:open-app", (appId) => {
  if (typeof appId === "string" && appById(appId)) void manager.openApp(appId);
});
onRenderer("open-profiler-window", () => manager.openProfiler());
onRenderer("window:open-projection", (session, frame) => {
  if (typeof session === "string" && session && typeof frame === "string" && frame)
    manager.openProjection({ session, frame });
});
// WS2 2b: toggle a module's `debug`-class sub-window. Owner = the current app
// window (apps are exclusive, so it's the opener); cascade tears it down on
// switch. `kind` selects the module component (debugger vs capture-preview,
// capture-recorder-nodes.md ruling 8) and keys a distinct window per kind.
onRenderer("window:toggle-debug", (session, kind) => {
  if (typeof session === "string" && session)
    manager.toggleDebug(session, manager.appWindow(), kind);
});
// Idempotent open-or-focus of the same `debug`-class sub-window (ruling 8 /
// Phase 4): the capture / raster buttons ENSURE the preview window is up.
onRenderer("window:open-debug", (session, kind) => {
  if (typeof session === "string" && session)
    manager.openDebug(session, manager.appWindow(), kind);
});

// ---- Dev restart (Ctrl/Cmd-Shift-R, multi-window.md req. 6 / §4) ----------
// Persist the window manifest → relaunch the whole app (orchestrator dies
// with main and boots fresh) → startup consumes the manifest below.
let restarting = false;
async function devRestart(): Promise<void> {
  if (restarting) return;
  restarting = true;
  manager.markQuitting();
  try {
    await saveManifest(DATA, manager.collectManifest());
  } catch (error) {
    console.error("Failed to persist window manifest:", error);
  }
  app.relaunch();
  // `app.exit()` skips `before-quit`, so run the quiesce handshake here: give
  // the orchestrator a beat to disable the MEMS controller + release cameras
  // (async serial write — a bare kill() can't complete it) before the hard
  // exit. Ack-based like the quit path; short deadline keeps dev restarts
  // snappy. Unlike before, add the JANITOR FALLBACK the audit flagged as
  // missing on this path (a wedged quiesce must not relaunch over armed
  // hardware).
  const proc = orchestrator;
  if (proc) {
    orchestratorExpectedExit = true;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.postMessage({ type: "shutdown" });
    await waitForQuiesceAck(2000);
    proc.kill();
    await Promise.race([exited, delay(500)]);
  }
  orchestrator = null;
  if (!orchestratorQuiesced) await ensureJanitor("dev restart");
  // The relaunched main spawns its own watchdog — stand this instance's down.
  standDownWatchdog();
  app.exit(0);
}

// ---- File association (A-11, recorder-container.md §4) --------------------
// macOS delivers double-clicked/dragged `.fcap`/`.fovea` files via `open-file` —
// which can fire BEFORE `whenReady` when the app is launched by the file
// itself, so pre-ready paths queue until the window manager can spawn.
// (Windows/Linux deliver file paths via argv → the `second-instance` handler
// below for a running instance; a fresh launch's argv is not wired yet —
// packaging-verified with the electron-builder `fileAssociations` later.)
const pendingOpenFiles: string[] = [];
let windowsReady = false;
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (windowsReady) manager.openViewer(filePath);
  else pendingOpenFiles.push(filePath);
});

// ---- Startup ---------------------------------------------------------------

async function createInitialWindows(): Promise<void> {
  // Dev restart restore: consume (one-shot) the persisted manifest and
  // restore that exact layout; anything else boots the default welcome.
  const manifest = IS_DEV ? await consumeManifest(DATA) : null;
  await manager.restore(planFromManifest(manifest));
  // Files double-clicked before/at launch (macOS open-file) open now, next
  // to the default layout (a viewer never suppresses welcome — it doesn't
  // count toward the welcome rule).
  windowsReady = true;
  for (const f of pendingOpenFiles.splice(0)) manager.openViewer(f);
}

app
  .whenReady()
  .then(sweepStaleWatchdogState)
  .then(customizeApp)
  .then(startOrchestrator)
  // Detached main-crash watchdog (gap 1): spawned once, right after the
  // orchestrator, so it is guarding energized hardware for the whole session.
  .then(spawnWatchdog)
  .then(createInitialWindows);

// Quit = graceful hardware quiescence first (safety invariant): ask the
// orchestrator to shut down (it drains sessions, DISABLES the MEMS controller
// over serial — an async write a bare SIGTERM can't complete — releases the
// cameras, and confirms `quiesced`), then quit for real. If it wedges or dies
// without confirming, the janitor cleans up out-of-process before we let
// Electron reap everything.
let quitting = false;
app.on("before-quit", (event) => {
  manager.markQuitting();
  if (quitting) return; // second pass: proceed with the real quit
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      // Gap 5 — WINDOW-FIRST teardown order (ruling 1/3): close owned
      // sub-windows (they cascade) then app/top windows, and let their teardown
      // (pipe reads, `window:closed`) flush BEFORE the orchestrator handshake,
      // so no renderer is mid pipe-read while the orchestrator disarms. Bounded
      // so a stuck window can't hang quit.
      manager.closeAll();
      await waitUntil(
        () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed()),
        3000,
      );
      // Viewer engines are MAIN-owned utilityProcesses independent of the
      // orchestrator/hardware — flush their sidecars (bounded) and reap them
      // before we exit (window close already kicked most off; this bounds it).
      await viewerEngines.killAll();
      // Orchestrator handshake (ruling 3/4): the orchestrator quiesces + posts
      // `quiesced` and WAITS; we reap it once we have the ack (authoritative
      // clean signal) or the deadline lapses (→ classified "killed").
      const proc = orchestrator;
      if (proc) {
        orchestratorExpectedExit = true;
        const exited = new Promise<void>((r) => proc.once("exit", () => r()));
        proc.postMessage({ type: "shutdown" });
        await waitForQuiesceAck(5000);
        proc.kill();
        await Promise.race([exited, delay(2000)]);
      }
      // Fallback if the ack never came (hung/killed quiesce).
      if (!orchestratorQuiesced) await ensureJanitor("app quit");
    } finally {
      orchestrator = null;
      // Clean shutdown reached — stand the crash watchdog down before we exit.
      standDownWatchdog();
      app.quit();
    }
  })();
});

app.on("window-all-closed", () => {
  // before-quit already owns the teardown order — don't race it (and on
  // non-darwin, closing the last window here during a controlled quit would
  // otherwise fire a premature app.quit()).
  if (quitting) return;
  // On non-macOS, no windows = quit.
  if (process.platform !== "darwin") {
    app.quit();
    return;
  }
  // Gap 2 — macOS keeps the app + menu bar alive with no windows, but it must
  // NEVER hold energized MEMS / streaming cameras headless (safety invariant).
  // Park the orchestrator (drain sessions, release cameras, DISABLE the MEMS
  // controller) while keeping the process for a fast dock re-activate, which
  // re-leases + re-arms on demand. Same disarm the app-switch drain performs,
  // plus the MEMS-off the headless state requires.
  orchestrator?.postMessage({ type: "park" });
});

app.on("second-instance", (_e, commandLine = []) => {
  // Windows/Linux file association: a second launch with recording args
  // (`.fcap`/legacy `.fovea`) lands here (single-instance lock) — open viewers
  // instead of focusing.
  const files = commandLine.filter(isRecordingPath);
  if (files.length > 0) {
    for (const f of files) manager.openViewer(f);
    return;
  }
  // Otherwise: focus an existing window, or bring the welcome window back.
  const open = manager.open();
  if (open.length > 0) open[0].focus();
  else manager.ensureWelcome();
});

app.on("activate", () => {
  const open = manager.open();
  if (open.length > 0) open[0].focus();
  else manager.ensureWelcome();
});
