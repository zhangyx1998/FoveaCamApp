// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  Menu,
  shell,
  ipcMain,
  utilityProcess,
  webContents,
  MessageChannelMain,
} from "electron";
import {
  OrchestratorInstances,
  type InstanceKind,
  type InstanceProc,
  type InstanceView,
} from "./orchestrator-instances";
import type { OrchestratorDownReport } from "./orchestrator-exit";
import type { ProbeCamera } from "@lib/orchestrator/probe";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { LogRing, type TeeFn } from "./log-ring";
import { enrichDownReport } from "./crash-report";
import { ViewerEngineManager, type EngineHandle } from "./viewer-engine";
import { TeleCanvasManager, type HostHandle } from "./telecanvas-manager";
import {
  DEFAULT_TELECANVAS_PORT,
  IDLE_TELECANVAS_TARGET,
  type TeleCanvasMode,
  type TeleCanvasStatus,
  type TeleCanvasTarget,
} from "@lib/telecanvas";
import { reviver } from "@lib/store-codec";
import type { AppConfig } from "@lib/config";
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

// ---- Native-crash minidumps (orchestrator-lifecycle-and-exit §"Crash
// diagnostics", AS SHIPPED) ------------------------------------------------
// A long-running orchestrator once aborted with a C++ `mutex lock failed`
// during a dev-restart teardown and macOS wrote NO .ips (crashpad was
// intercepted while the parent restarted). Start Electron's own crashReporter
// so native faults in the utilityProcess children (the orchestrator owns
// `core`/Aravis/OpenCV) land a LOCAL minidump — never uploaded (no server).
// `crashDumps` is redirected to a stable, human-findable dir under userData so
// the instance registry can pair a fresh dump with the dying instance and cite
// its path in the typed down report. Must run before app-ready and before any
// child forks. NOTE: `crashDumps` is Chromium's own path key (distinct from our
// `crash-logs` ring dir); redirect it FIRST so the reporter picks it up.
const CRASH_DUMPS_DIR = path.join(DATA, "crash-dumps");
const CRASH_LOGS_DIR = path.join(DATA, "crash-logs");
try {
  app.setPath("crashDumps", CRASH_DUMPS_DIR);
} catch (e) {
  console.warn("[crash] setPath(crashDumps) failed:", e);
}
crashReporter.start({
  // Local-only: no collection endpoint, nothing leaves the machine.
  uploadToServer: false,
  submitURL: undefined,
  productName: "FoveaCam",
  // Keep OS crash reporting too (belt-and-suspenders) — crashpad still writes
  // our minidump either way.
  ignoreSystemCrashHandler: false,
  compress: false,
});

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
  const isMac = process.platform === "darwin";
  // "Settings…" / Cmd+, — OS Preferences convention: on macOS it lives in the
  // app menu (right after About); on Windows/Linux it lives in the File menu.
  // Both route to the singleton config window (open-or-focus).
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => openConfigWindow(),
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu, hand-built (not `role: "appMenu"`) so the Settings item
    // lands where the platform expects it.
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              settingsItem,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
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
        // Windows/Linux Preferences convention: Settings under File.
        ...(!isMac
          ? [{ type: "separator" as const }, settingsItem]
          : []),
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
  // A push to a dying window is correct to DROP, never fatal (incident
  // 2026-07-09: `orchestrator:down` threw "Render frame was disposed before
  // WebFrameMain could be accessed" here while the parent restarted). Guard the
  // obvious destroyed case, and wrap `send` too — the render frame can be
  // disposed in the window between this check and the actual send (webFrameMain
  // race), which `isDestroyed()` won't catch. Log at debug; never throw.
  if (wc.isDestroyed()) {
    console.debug(`[push] drop "${String(channel)}" → destroyed webContents`);
    return;
  }
  try {
    wc.send(channel, ...args);
  } catch (e) {
    console.debug(
      `[push] drop "${String(channel)}" → ${(e as Error).message}`,
    );
  }
}

// ---- Renderer bridge handlers (docs/history/refactor/orchestrator.md §7.1 T5) -----
// The renderer's `SavePath`/`SaveControls`/`RecordControls` used to call
// `node:path`/`node:fs`/`node:os` directly — reachable only under the old
// `nodeIntegration: true`. These mirror that logic here so `foveaBridge`
// (preload-bridge.ts) can forward to it over IPC instead.
handle("save-path:resolve", (segments) => path.resolve(...segments));
handle("save-path:resolve-default", (directory, base) =>
  resolveDefaultSavePath(directory, base),
);
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

// Reveal a crash-diagnostics file (the flushed ring log or a native minidump)
// in Finder/Explorer — the CrashReport banner's "Reveal in Finder" affordance.
handle("crash:reveal", (file) => {
  if (typeof file === "string" && file && existsSync(file))
    shell.showItemInFolder(file);
});

// ---- Orchestrator instances (disposable per app, ruling 2) ----------------
// Each app activation forks a FRESH orchestrator utilityProcess that owns `core`
// (cameras, vision, control, hardware I/O); closing/switching the app disposes
// it (bounded drain-and-quiesce → ack/timeout → kill → janitor). Teardown errors
// die with the process, so the Welcome launcher never wedges. The instance
// registry (`orchestrator-instances.ts`, Electron-free + unit-tested) owns the
// typed table + the ≤1-hardware gate; the fork/port/janitor wiring is injected
// below. Main brokers a direct MessagePort between each renderer and its
// instance; frames/commands then flow point-to-point.
let registry!: OrchestratorInstances;
let drainSeq = 0;
// Per-instance window:drain resolvers (the switch busy-check) — keyed by
// instance id then request seq, so a dying instance's pending drains can be
// settled without touching another instance's.
const instanceDrains = new Map<string, Map<number, (r: { ok: boolean; reason?: string }) => void>>();
// windowId → its live webContents, so the registry's `notifyDown` can push a
// crash report to a dying instance's OWNED windows only (ruling 4 scoping).
const webContentsByWindowId = new Map<string, Electron.WebContents>();
// instanceId → its last down report, so a profiler that connects AFTER its
// bound instance already died still gets the typed frozen banner (the connect
// broker replays it — the profiler never re-attaches to another instance).
const lastDownReports = new Map<string, OrchestratorDownReport>();
// instanceId → its stdout/stderr ring + fork timestamp (crash diagnostics). The
// orchestrator (ONLY) is forked with piped stdio; every chunk is tee'd faithfully
// to this parent's terminal while the ring keeps a bounded tail. On a non-clean
// exit `enrichDownReport` flushes the ring to a file and pairs a fresh minidump.
const instanceLogs = new Map<string, { ring: LogRing; spawnTs: number }>();

/** Find the newest `.dmp` minidump under the crashDumps dir whose mtime is at
 *  or after `sinceMs` (the instance's fork time) — best-effort: a minidump may
 *  not be flushed by the time we observe the exit, and multiple instances share
 *  the dir, so we can only attribute by "newer than this fork". */
function findRecentDump(sinceMs: number): string | undefined {
  try {
    const entries = readdirSync(CRASH_DUMPS_DIR, {
      recursive: true,
      withFileTypes: true,
    });
    let best: { path: string; mtime: number } | undefined;
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".dmp")) continue;
      const full = path.join(e.parentPath, e.name);
      let mtime: number;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      // `- 1000` tolerance: fork-ts and file-mtime clocks aren't identical.
      if (mtime >= sinceMs - 1000 && (!best || mtime > best.mtime))
        best = { path: full, mtime };
    }
    return best?.path;
  } catch {
    return undefined;
  }
}

/** Flush an instance's ring text to `<userData>/crash-logs/<id>-<ts>.log`;
 *  return the path written, or undefined on failure (best-effort — the injected
 *  `writeLog` dep for the pure `enrichDownReport`). */
function writeCrashLog(id: string, text: string): string | undefined {
  try {
    mkdirSync(CRASH_LOGS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(CRASH_LOGS_DIR, `${id}-${stamp}.log`);
    writeFileSync(file, text, "utf8");
    console.warn(`[crash] ${id}: log written → ${file}`);
    return file;
  } catch (e) {
    console.warn(`[crash] failed to write crash log for ${id}:`, e);
    return undefined;
  }
}

// ---- Hardware janitor (safety invariant, docs/hardware/stage-f.md) --------
// An instance confirms `quiesced` (MEMS disabled + cameras released) before a
// graceful exit. If one EVER exits without that confirmation — SIGABRT from
// native code, SIGSEGV, OOM kill — the armed hardware outlives it, so main forks
// this one-shot cleanup process (orchestrator/janitor.ts): fresh process, fresh
// device claims, disables the MEMS controller over serial and stops every
// camera's acquisition (which also clears TLParamsLocked, unblocking the next
// instance's config restore). The registry decides clean-vs-crash from the
// ack (never the exit code) and calls this on every non-clean instance death.

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
 *  `orchestratorPids` is the CURRENT set of live instance pids (disposable
 *  model, ruling 5: 0..N alive), refreshed whenever the set changes so the
 *  watchdog waits on the right orphans before quiescing. */
function writeWatchdogState(): void {
  try {
    writeFileSync(
      watchdogStatePath,
      JSON.stringify({
        mainPid: process.pid,
        orchestratorPids: registry?.livePids() ?? [],
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

/** Fork + wire ONE orchestrator instance (the registry's `fork` dep). Routes
 *  the instance's ack / drain-result / recording-finished / exit back to the
 *  registry + window manager. `id` scopes the per-instance drain map. */
function forkInstance(id: string, kind: InstanceKind): InstanceProc {
  const entry = path.join(DIR, "orchestrator.js");
  const forkTs = Date.now();
  // The orchestrator (and ONLY the orchestrator — janitor/probe/viewer/
  // telecanvas keep `inherit`) is forked with PIPED stdio so a per-instance ring
  // buffer can keep its last output for the crash report. Every chunk is tee'd
  // faithfully (unbuffered, in order) straight through to this parent's
  // stdout/stderr, so the dev-terminal experience is unchanged.
  const proc = utilityProcess.fork(entry, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Each instance reads/writes the same config store as the renderer.
      FOVEA_DATA_PATH: DATA,
      // Boot-span baseline (§7.1 S5) — stamped as close to `fork()` as possible
      // so `index.ts` can measure fork -> first-useful-work timing per instance.
      FOVEA_FORK_TS: String(forkTs),
      FOVEA_INSTANCE_KIND: kind,
    },
  });
  // Per-instance ring: keep the last ~256 lines / 64 KiB of interleaved stdout+
  // stderr (crash diagnostics). Tee each raw chunk to the matching parent stream
  // FIRST so the terminal sees exactly the child's bytes.
  const ring = new LogRing();
  instanceLogs.set(id, { ring, spawnTs: forkTs });
  const teeOut: TeeFn = (c) => process.stdout.write(c);
  const teeErr: TeeFn = (c) => process.stderr.write(c);
  proc.stdout?.on("data", (c: Buffer) => ring.push(c, teeOut));
  proc.stderr?.on("data", (c: Buffer) => ring.push(c, teeErr));
  // The watchdog needs the CURRENT instance pids; `pid` is populated on spawn.
  proc.on("spawn", () => writeWatchdogState());
  proc.on("message", (data: unknown) => {
    const msg = data as {
      type?: string;
      id?: number;
      ok?: boolean;
      reason?: string;
      path?: string;
    };
    if (msg?.type === "quiesced") {
      // The authoritative clean-exit ack (ruling 3/4) — the registry reaps it.
      registry.onAck(id);
      return;
    }
    // Phase 5 auto-open (capture-recorder-nodes.md ruling 8): a recorder node
    // finalized a container — surface it in a STANDALONE viewer window (one per
    // file; the window does its own playback — standalone-viewer-and-fcap 1).
    if (msg?.type === "recording:finished") {
      if (typeof msg.path === "string" && msg.path) manager.openViewer(msg.path);
      return;
    }
    if (msg?.type !== "window:drain-result" || msg.id === undefined) return;
    const map = instanceDrains.get(id);
    map?.get(msg.id)?.({ ok: !!msg.ok, reason: msg.reason });
    map?.delete(msg.id);
  });
  proc.on("exit", (code) => {
    console.warn(`Orchestrator instance ${id} exited:`, code);
    // Registry classifies (ack-based), janitors non-clean paths, surfaces the
    // down report to owned windows, and re-attempts the hardware-clear gate.
    // `notifyDown` runs synchronously inside this call and reads `instanceLogs`,
    // so the ring must still be present here — drop it only AFTER onExit.
    registry.onExit(id, code ?? null);
    instanceLogs.delete(id);
    // A dead instance has nothing left to drain — unblock any switch waiting on
    // it rather than letting it time out.
    const map = instanceDrains.get(id);
    if (map) {
      for (const resolve of map.values()) resolve({ ok: true });
      instanceDrains.delete(id);
    }
  });
  return {
    postMessage: (message: unknown, transfer?: unknown[]) =>
      proc.postMessage(message, transfer as Electron.MessagePortMain[] | undefined),
    kill: () => proc.kill(),
    get pid() {
      return proc.pid;
    },
  };
}

// ---- Camera-enumeration probe (disposable-orchestrator ruling 3) ----------
// A small persistent enumerate-only process that feeds the status-only Welcome
// window a live camera list + connected state. It NEVER opens a camera, holds
// no hardware, gates nothing, and outlives app instances; main restarts it if
// it dies and kills it at quit. Paused while a hardware instance is alive (the
// registry's `onHardwareAliveChange` dep below) so its `Camera.list()` never
// contends with an app's exclusive acquisition; resumed back at Welcome.
let probe: ReturnType<typeof utilityProcess.fork> | null = null;
let probeQuitting = false;
function spawnProbe(): void {
  if (probe || probeQuitting) return;
  probe = utilityProcess.fork(path.join(DIR, "probe.js"), [], {
    stdio: "inherit",
    env: { ...process.env, FOVEA_DATA_PATH: DATA },
  });
  probe.on("message", (data: unknown) => {
    const msg = data as { type?: string; cameras?: ProbeCamera[] };
    if (msg?.type === "probe:cameras")
      for (const w of BrowserWindow.getAllWindows())
        pushTo(w.webContents, "probe:cameras", msg.cameras ?? []);
  });
  probe.on("exit", (code) => {
    probe = null;
    if (probeQuitting) return;
    console.warn("[probe] exited unexpectedly — restarting:", code);
    setTimeout(spawnProbe, 500);
  });
  // If a hardware instance is already alive when the probe (re)spawns, it must
  // start paused so it never contends with the app's exclusive acquisition.
  if (registry?.hardwareAlive()) probe.postMessage({ type: "probe:pause" });
}
function killProbe(): void {
  probeQuitting = true;
  probe?.kill();
  probe = null;
}

registry = new OrchestratorInstances({
  fork: forkInstance,
  sendHardwareClear: (inst) => inst.proc.postMessage({ type: "hardware-clear" }),
  sendShutdown: (inst) => inst.proc.postMessage({ type: "shutdown" }),
  kill: (inst) => inst.proc.kill(),
  // Reuse the deduped hardware janitor as the per-instance non-clean-death
  // sweep; it disarms ALL hardware in a fresh process regardless of instance.
  runJanitor: (inst, reason) => ensureJanitor(`${inst.id}: ${reason}`),
  notifyDown: (inst, rawReport) => {
    // Enrich a non-clean exit with crash diagnostics (flush the stdout/stderr
    // ring to a file, inline a tail, pair a fresh minidump) BEFORE it is
    // remembered/pushed, so both the live banner and a late-attaching profiler
    // replay see the same enriched report. Clean exits pass through untouched.
    const report = enrichDownReport(rawReport, instanceLogs.get(inst.id), {
      writeLog: (text) => writeCrashLog(inst.id, text),
      findDump: findRecentDump,
    });
    // Remember it so a profiler that attaches after this death still gets the
    // frozen banner (the connect broker replays it below).
    lastDownReports.set(inst.id, report);
    // Scope the down report to the DYING instance's OWNED windows (ruling 4)
    // PLUS its attached observer windows (the profiler, ruling 2 — it freezes
    // with its accumulated data and shows "session ended/crashed"): a NEW
    // instance's app window must never react to the OLD instance's death. On a
    // crash the app window is still open (its channel rejects in-flight calls +
    // CrashReport.vue shows); on a clean switch/close its app window is already
    // gone, so only a surviving profiler is informed (correct).
    const targets = new Set([
      ...registry.windowsOf(inst.id),
      ...registry.attachmentsOf(inst.id),
    ]);
    for (const windowId of targets) {
      const wc = webContentsByWindowId.get(windowId);
      if (wc && !wc.isDestroyed()) pushTo(wc, "orchestrator:down", report);
    }
  },
  // Pause the enumerate-only probe while a hardware instance is alive (Aravis
  // is per-process exclusive — a background `Camera.list()` must not contend
  // with the app's exclusive acquisition); resume at the Welcome screen.
  onHardwareAliveChange: (alive) => {
    probe?.postMessage({ type: alive ? "probe:pause" : "probe:resume" });
    // Viewer banner (viewer-export addendum): tell every window a live capture
    // session started/stopped (function-declaration-hoisted; runs at edge time).
    broadcastAppSessionActive(alive);
  },
  // Keep the crash-watchdog state file tracking whichever instances are alive.
  onLivePidsChange: () => writeWatchdogState(),
  quiesceMs: 4000,
});

/** Ask an instance to idle every camera-owning session and wait for the
 *  releases to settle (multi-window.md §3 — "closed" = session-idle-drained).
 *  `{ok: false}` = refused: a session is mid-capture/recording. */
function drainInstance(inst: InstanceView): Promise<{ ok: boolean; reason?: string }> {
  const seq = ++drainSeq;
  let map = instanceDrains.get(inst.id);
  if (!map) instanceDrains.set(inst.id, (map = new Map()));
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      map!.delete(seq);
      resolve({ ok: false, reason: "session drain timed out (10s)" });
    }, 10_000);
    map!.set(seq, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    inst.proc.postMessage({ type: "window:drain", id: seq });
  });
}

/** The switch drain (window-manager dep): busy-check + best-effort session
 *  drain of the OUTGOING hardware instance, then dispose it (its process death
 *  is the containment). `{ok:false}` keeps the current app (mid-capture/
 *  recording). With no current instance (first app from Welcome) it's a no-op
 *  pass. Note the new instance forks separately at app-window spawn and defers
 *  hardware until this outgoing one is confirmed dead + swept. */
function drainSessions(): Promise<{ ok: boolean; reason?: string }> {
  const cur = registry.currentHardware();
  if (!cur) return Promise.resolve({ ok: true });
  return drainInstance(cur).then((result) => {
    if (result.ok) registry.teardown(cur.id, "app switch");
    return result;
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
  const windowId = windowIdBySender.get(event.sender.id) ?? null;
  // Instance-scoped brokering (ruling 6). A window BOUND to a specific instance
  // — an app window (owns it) or a profiler (attached at open, per-instance
  // binding) — routes to THAT instance and NOTHING else. If its instance is
  // already dead, fail CLOSED: replay the typed down report (frozen "session
  // ended/crashed" banner) and broker no port — a profiler must never connect
  // to another session (ruling 2). An UNBOUND window (projection/debug) routes
  // to the CURRENT live app instance. With no app instance at all — the
  // status-only Welcome, which never connects — there is nothing to broker.
  const bound = windowId ? registry.boundInstance(windowId) : null;
  let target: InstanceProc | null;
  if (bound) {
    if (bound.phase === "dead") {
      const report = lastDownReports.get(bound.id) ?? { reason: "killed", code: null };
      pushTo(event.sender, "orchestrator:down", report);
      return;
    }
    target = bound.proc;
  } else {
    target = registry.connectTarget();
  }
  if (!target) return;
  const { port1, port2 } = new MessageChannelMain();
  target.postMessage({ type: "channel:connect", windowId }, [port1]);
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

// ---- Viewer video export (viewer-export.md) -------------------------------
// Main owns the system save dialog (spec 8) + the window-close abort intercept
// (spec 11). The ffmpeg pipeline itself lives in the viewer ENGINE (utility
// process) — main only brokers the save path + the close handshake.

// Sender (viewer webContents id) → does it have queued/running exports? The
// renderer pushes on every 0-crossing; `close` reads it to decide whether to
// intercept. A confirmed-abort close is recorded so the re-`close()` passes.
const viewerExportsActive = new Map<number, boolean>();
const viewerCloseConfirmed = new Set<number>();

ipcMain.on("viewer:exports-active" satisfies keyof SendChannels, (event, active) => {
  viewerExportsActive.set(event.sender.id, !!active);
});
ipcMain.on("viewer:close-confirmed" satisfies keyof SendChannels, (event) => {
  const id = event.sender.id;
  viewerCloseConfirmed.add(id); // let the next close() through the intercept
  viewerExportsActive.set(id, false);
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// The video-export save dialog (spec 8): default filename `<recording>-<stream>`
// with the codec's container extension, filtered to that extension.
handle("export:save-dialog", async (defaultName, ext) => {
  const focused = BrowserWindow.getFocusedWindow();
  const options = {
    defaultPath: `${defaultName}.${ext}`,
    filters: [{ name: `${ext.toUpperCase()} video`, extensions: [ext] }],
  };
  const result = focused
    ? await dialog.showSaveDialog(focused, options)
    : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
});

// ---- Live-session banner broadcast (viewer-export addendum) ----------------
// Main is the only process that knows BOTH a viewer window and the per-app
// hardware instances (registry). Mirror the telecanvas:target seed+push pattern:
// seed via invoke, push to EVERY window on the hardware-alive edge.
handle("app-session:active", () => registry.hardwareAlive());

function broadcastAppSessionActive(active: boolean): void {
  for (const w of BrowserWindow.getAllWindows())
    pushTo(w.webContents, "app-session:active", active);
}

// ---- TeleCanvas host server (standalone dual-mode module) -----------------
// Main owns the host utilityProcess: spawn when `tele_canvas_mode` is "host",
// kill on client/off or quit, respawn on crash (TeleCanvasManager). Main has no
// live store watcher, so its knowledge of {mode, port} comes from (1) the
// persisted config read once at startup and (2) an IPC nudge (`telecanvas:apply`)
// the config-editing windows send on change — apply() is idempotent, so a nudge
// from more than one window is harmless. Status is broadcast to every renderer.
const TELECANVAS_HOST_ENTRY = path.join(DIR, "telecanvas-host.js");

function createTeleCanvasHost(port: number): HostHandle {
  const proc = utilityProcess.fork(TELECANVAS_HOST_ENTRY, [], {
    stdio: "inherit",
    env: { ...process.env, FOVEA_TELECANVAS_PORT: String(port) },
  });
  const handle: HostHandle = { kill: () => proc.kill() };
  proc.on("message", (data: unknown) => {
    const msg = data as { type?: string; port?: number; error?: string };
    if (msg?.type === "telecanvas:listening")
      telecanvas.onListening(handle, msg.port ?? port);
    else if (msg?.type === "telecanvas:error")
      telecanvas.onError(handle, msg.error ?? "host server failed to listen");
  });
  proc.on("exit", () => telecanvas.onExit(handle));
  return handle;
}

// The authoritative push-target config {mode, url, port} — main is the single
// always-alive process, so an app-window `Pusher` in a DIFFERENT orchestrator
// instance learns a settings edit here (the per-instance `["config"]` store-hub
// broadcast does NOT cross instances). Seeded from persisted config at startup,
// updated on every `telecanvas:apply` nudge, and re-broadcast on every host
// status change (so a fresh host after a respawn gets its buffer refilled by the
// next Pusher PUT).
let telePushTarget: TeleCanvasTarget = { ...IDLE_TELECANVAS_TARGET };

function broadcastTeleCanvasTarget(): void {
  for (const w of BrowserWindow.getAllWindows())
    pushTo(w.webContents, "telecanvas:target", telePushTarget);
}

function broadcastTeleCanvasStatus(status: TeleCanvasStatus): void {
  for (const w of BrowserWindow.getAllWindows())
    pushTo(w.webContents, "telecanvas:status", status);
  // Re-announce the target alongside every status change: a host (re)listen
  // (crash respawn / port change) then re-fires the Pusher so it re-PUTs the
  // current content into the fresh server's empty buffer (content preservation).
  broadcastTeleCanvasTarget();
}

const telecanvas = new TeleCanvasManager({
  fork: createTeleCanvasHost,
  interfaces: () => os.networkInterfaces(),
  onStatus: broadcastTeleCanvasStatus,
});

onRenderer("telecanvas:apply", (mode, port, url) => {
  const m: TeleCanvasMode = mode === "host" ? "host" : "client";
  const p = Number(port) || DEFAULT_TELECANVAS_PORT;
  telePushTarget = { mode: m, port: p, url: typeof url === "string" ? url : "" };
  telecanvas.apply(m, p); // host lifecycle (also re-broadcasts the target via onStatus)
  broadcastTeleCanvasTarget(); // ensure a client-only change (no host status) still reaches app windows
});
handle("telecanvas:get-status", () => telecanvas.status());
handle("telecanvas:get-target", () => telePushTarget);

/** Read the persisted app config directly off disk (like the window manifest) —
 *  main has no store-hub client, and this is only needed once at startup to
 *  decide whether the host should come up before any window nudges it. */
function readPersistedConfig(): Partial<AppConfig> {
  try {
    const file = path.join(DATA, "store", "config.json");
    if (!existsSync(file)) return {};
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") return {};
    return JSON.parse(text, reviver) as Partial<AppConfig>;
  } catch (e) {
    console.error("[telecanvas] failed to read persisted config:", e);
    return {};
  }
}

function applyPersistedTeleCanvas(): void {
  const cfg = readPersistedConfig();
  const mode: TeleCanvasMode = cfg.tele_canvas_mode === "host" ? "host" : "client";
  const port = Number(cfg.tele_canvas_port) || DEFAULT_TELECANVAS_PORT;
  // Seed the authoritative push target so a `getTeleCanvasTarget` at app-window
  // mount reflects the persisted config before any settings-window nudge.
  telePushTarget = { mode, port, url: cfg.tele_canvas_url ?? "" };
  telecanvas.apply(mode, port);
}

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
  // Disposable-orchestrator (ruling 2): an APP window forks a FRESH hardware
  // instance and owns it. The window is claimed now so its close disposes the
  // instance (registry.onWindowClosed → drain-and-quiesce → kill → janitor).
  // The renderer's `orchestrator:connect` (after load) then brokers to it.
  if (desc.class === "app" && desc.windowId) {
    // Name the instance by its activating app id — a bound profiler titles
    // itself with this session (e.g. "manual-control · #hw-1").
    const inst = registry.open("hardware", desc.appId);
    registry.claimWindow(inst.id, desc.windowId);
  }
  // A-34: sender→windowId lookup for the orchestrator channel handshake (the
  // connect IPC only knows `event.sender`), + the close-teardown signal C-24's
  // composition keys `win/<windowId>/...` namespaces on.
  if (desc.windowId) {
    const windowId = desc.windowId;
    const senderId = win.webContents.id; // captured now — webContents is gone by "closed"
    windowIdBySender.set(senderId, windowId);
    webContentsByWindowId.set(windowId, win.webContents);
    win.on("closed", () => {
      windowIdBySender.delete(senderId);
      webContentsByWindowId.delete(windowId);
      // Route the per-window teardown signal (C-24 compose `win/<id>` state) to
      // the instance BOUND to this window (owned app, or an attached profiler),
      // else the current instance (an unbound projection/debug). Skip a DEAD
      // binding — a profiler that outlived its instance has nothing to notify
      // (and its instance's process is gone). Then let the registry dispose the
      // instance when its last OWNED window is gone (attachments never gate it).
      const owner = registry.boundInstance(windowId) ?? registry.currentHardware();
      if (owner && owner.phase !== "dead")
        owner.proc.postMessage({ type: "window:closed", windowId });
      registry.onWindowClosed(windowId);
    });
  }
  // Viewer windows: flush + kill this window's playback engine on close
  // (flush-before-close single-writer sidecar). Captured now — the webContents
  // is gone by "closed".
  if (desc.class === "viewer") {
    const engineKey = win.webContents.id;
    // Export abort-on-close intercept (viewer-export spec 11): while this window
    // has queued/running exports, the FIRST close is intercepted — ask the
    // renderer to confirm the abort; it aborts + calls `confirmViewerClose`,
    // which re-`close()`s with the confirmed flag set (letting this pass).
    win.on("close", (e) => {
      if (viewerCloseConfirmed.has(engineKey)) return; // confirmed → proceed
      if (!viewerExportsActive.get(engineKey)) return; // no exports → proceed
      e.preventDefault();
      pushTo(win.webContents, "viewer:confirm-close");
    });
    win.on("closed", () => {
      viewerExportsActive.delete(engineKey);
      viewerCloseConfirmed.delete(engineKey);
      void viewerEngines.close(engineKey); // engine also abortAll()s exports
    });
  }
  // Settings / TeleCanvas window closed: release the shared non-hardware
  // "settings" instance main may have forked to back the store (disposed only
  // when the LAST store-window closes; a no-op when it was instead sharing a
  // live app instance's store-hub).
  if (desc.class === "config") win.on("closed", () => releaseSettingsInstance("config"));
  if (desc.class === "telecanvas")
    win.on("closed", () => releaseSettingsInstance("telecanvas"));
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

// ---- App-wide Settings window (Cmd+, / "Settings…") -----------------------
// The config window is a SINGLETON, UNBOUND window. Its store connection routes
// through the standard unbound-connect broker to the live app (hardware)
// instance when one exists — sharing that instance's store-hub, so a config
// edit applies LIVE across windows (e.g. calibrate-extrinsic's marker sliders)
// via the existing `Store.open` broadcast. With NO app running (opened from
// Welcome) there is no instance to serve the config store, so main forks a
// lightweight NON-hardware "settings" instance to back it; it holds no hardware
// (never pauses the probe, never blocks an app's hardware-clear) and is disposed
// when the config window closes.
let settingsInstanceId: string | null = null;
// The config AND TeleCanvas windows both need the store (config docs) but hold
// no hardware — they SHARE one non-hardware "settings" instance, refcounted by
// window class so closing one while the other is open keeps the store alive.
const settingsConsumers = new Set<WindowClass>();
function ensureSettingsInstance(): void {
  // Still alive? nothing to do.
  if (settingsInstanceId && registry.live().some((i) => i.id === settingsInstanceId))
    return;
  settingsInstanceId = null;
  // A live app instance already serves the store — the unbound connect routes
  // to it (shared store-hub → live cross-window apply).
  if (registry.hardwareAlive()) return;
  settingsInstanceId = registry.open("non-hardware", "settings").id;
}
function acquireSettingsInstance(consumer: WindowClass): void {
  settingsConsumers.add(consumer);
  ensureSettingsInstance();
}
function releaseSettingsInstance(consumer: WindowClass): void {
  settingsConsumers.delete(consumer);
  if (settingsConsumers.size > 0) return; // another store window still open
  if (!settingsInstanceId) return;
  registry.teardown(settingsInstanceId, "settings/telecanvas window closed");
  settingsInstanceId = null;
}
function openConfigWindow(): void {
  acquireSettingsInstance("config");
  manager.openConfig();
}
function openTeleCanvasWindow(): void {
  acquireSettingsInstance("telecanvas");
  manager.openTeleCanvas();
}
onRenderer("window:open-config", () => openConfigWindow());
onRenderer("window:open-telecanvas", () => openTeleCanvasWindow());

onRenderer("window:open-app", (appId) => {
  if (typeof appId === "string" && appById(appId)) void manager.openApp(appId);
});
// Open a profiler pinned to the CURRENT live app instance (per-instance
// binding, orchestrator-lifecycle-and-exit §"Profiler per-instance binding").
// The binding is stamped into the window URL + registered as an observer
// ATTACHMENT (never an owned window, so closing the profiler can't dispose the
// instance, and the instance's death can't close the profiler). Opened from the
// status-only Welcome (no live instance) it's unbound — "no active session".
onRenderer("open-profiler-window", () => {
  const inst = registry.currentHardware();
  const win = manager.openProfiler(
    inst ? { instanceId: inst.id, sessionName: inst.sessionName } : {},
  );
  if (inst && win.windowId) registry.attachWindow(inst.id, win.windowId);
});
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
  // `app.exit()` skips `before-quit`, so dispose the current instance(s) here:
  // each drains + disarms hardware + acks (the registry kills + janitors any
  // that wedge). Bounded so a hung quiesce can't stall the relaunch over armed
  // hardware. The probe (utilityProcess child) dies with main; the relaunched
  // main spawns fresh ones (ruling 5: instance killed → fresh on next open;
  // probe survives via respawn).
  registry.teardownAll("dev restart");
  await waitUntil(() => !registry.anyAlive(), 3000);
  killProbe();
  telecanvas.killAll();
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
  // Disposable model (ruling 2/3): no orchestrator is spawned at startup — app
  // instances fork on demand at app-window open. The enumerate-only PROBE and
  // the detached main-crash WATCHDOG come up now instead, so Welcome shows the
  // live camera list and the safety net is armed for the whole session.
  .then(spawnProbe)
  .then(spawnWatchdog)
  // TeleCanvas host: if the persisted config selected host mode, bring the
  // server up now so an external display can connect before any app opens.
  .then(applyPersistedTeleCanvas)
  .then(createInitialWindows);

// Quit = graceful hardware quiescence first (safety invariant): dispose EVERY
// live instance (each drains sessions, DISABLES the MEMS controller over serial
// — an async write a bare SIGTERM can't complete — releases the cameras, and
// confirms `quiesced`); the registry kills + janitors any that wedge. Then kill
// the probe + stand the watchdog down, and quit for real.
let quitting = false;
app.on("before-quit", (event) => {
  manager.markQuitting();
  if (quitting) return; // second pass: proceed with the real quit
  quitting = true;
  event.preventDefault();
  void (async () => {
    try {
      // WINDOW-FIRST teardown order (ruling 1/3): close owned sub-windows (they
      // cascade) then app/top windows, and let their teardown (pipe reads,
      // `window:closed`) flush BEFORE the instance handshakes, so no renderer is
      // mid pipe-read while an instance disarms. Bounded so a stuck window can't
      // hang quit. (Closing an app window already begins its instance teardown.)
      manager.closeAll();
      await waitUntil(
        () => BrowserWindow.getAllWindows().every((w) => w.isDestroyed()),
        3000,
      );
      // Viewer engines are MAIN-owned utilityProcesses independent of the
      // instances/hardware — flush their sidecars (bounded) and reap them.
      await viewerEngines.killAll();
      // Instance handshakes (ruling 3/4): every live instance quiesces + acks;
      // the registry reaps on the ack or kills + janitors at the bounded
      // deadline. Await all deaths (bounded — the per-instance timers guarantee
      // progress even if this outer wait lapses).
      registry.teardownAll("app quit");
      await waitUntil(() => !registry.anyAlive(), 6000);
    } finally {
      killProbe();
      // Kill the TeleCanvas host (main-owned utilityProcess, no hardware).
      telecanvas.killAll();
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
  // Disposable model (ruling 5): PARK is retired. With no app window there is no
  // hardware instance at all — closing the app window already disposed its
  // instance (drain → quiesce → kill → janitor), so nothing is held headless.
  // The enumerate-only probe holds nothing; the macOS app idles safely with the
  // menu bar until a dock re-activate re-opens Welcome.
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
