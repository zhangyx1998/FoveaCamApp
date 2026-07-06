// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  utilityProcess,
  MessageChannelMain,
  type UtilityProcess,
} from "electron";
// import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { getIcon } from "./util";
import { resolveDefaultSavePath, validateWritablePath } from "@lib/util/fs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = app.getPath("userData");

// The built directory structure
//
// ├─┬ .dist/electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ .dist/renderer
// │ └── index.html    > Electron-Renderer
//
const DIST = path.join(DIR, "..");
process.env.APP_ROOT = path.join(DIR, "../..");

export const MAIN_DIST = path.join(DIST, "electron");
export const RENDERER_DIST = path.join(DIST, "renderer");
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

// Set application name for Windows 10+ notifications
if (process.platform === "win32") app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
const shmStreamsEnabled = process.env.FOVEA_SHM_STREAMS === "1";
const preload = path.join(DIR, shmStreamsEnabled ? "preload-shm.mjs" : "preload.mjs");
const profilerPreload = path.join(DIR, "preload.mjs");
const indexHtml = path.join(RENDERER_DIST, "index.html");

async function createWindow() {
  win = new BrowserWindow({
    title: "FoveaCam Duo",
    icon: getIcon("icon.ico"),
    // Don't show until ready
    // show: false,
    // Window customization
    // frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#2f3241",
      symbolColor: "#74b1be",
      height: 40,
    },
    minHeight: 600,
    minWidth: 800,
    height: 900,
    width: 1200,
    backgroundColor: "black",
    webPreferences: {
      preload,
      // Flipped (docs/refactor/orchestrator.md §7.1 T5 phase b) — every
      // renderer-side Node/Electron API access was moved behind
      // `window.foveaBridge` (electron/preload.ts) first, so this is a
      // one-line revert if something surfaces that phase (a) missed.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: !shmStreamsEnabled,
    },
  });

  // Show window when ready to avoid white/black flash
  // win.once("ready-to-show", () => win.show());

  win.maximize();

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
    // Open devTool if the app is not packaged
    // win.webContents.openDevTools();
  } else {
    win.loadFile(indexHtml);
  }

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) shell.openExternal(url);
    return { action: "deny" };
  });
  // win.webContents.on('will-navigate', (event, url) => { }) #344
}

function customizeApp() {
  if (process.platform === "darwin") {
    const icon = getIcon("1024x1024.png");
    app.dock.setIcon(icon);
  }
  app.setName("FoveaCam Duo");
}

// ---- Renderer bridge handlers (docs/refactor/orchestrator.md §7.1 T5) -----
// The renderer's `SavePath`/`SaveControls`/`RecordControls` used to call
// `node:path`/`node:fs`/`node:os` directly — reachable only under today's
// `nodeIntegration: true` (the renderer polyfill for those needs a real
// `require`). These mirror that logic here so `foveaBridge` (preload.ts) can
// forward to it over IPC instead.
ipcMain.handle("save-path:resolve", (_e, segments: string[]) =>
  path.resolve(...segments),
);
ipcMain.handle("save-path:resolve-default", (_e, directory: string) =>
  resolveDefaultSavePath(directory),
);
ipcMain.handle("fs:exists", (_e, p: string) => existsSync(p));
ipcMain.handle("fs:validate-writable", (_e, p: string) => validateWritablePath(p));
ipcMain.handle("perf-snapshot:write", async (_e, content: string) => {
  const dir = path.join(DATA, "perf-snapshots");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, content);
  return file;
});

// ---- Orchestrator process -------------------------------------------------
// A utilityProcess that owns `core` (cameras, vision, control, hardware I/O).
// Its event loop is independent of any renderer's render loop. Main only brokers
// a direct MessagePort between each renderer and the orchestrator; frames and
// commands then flow point-to-point without routing through here.
let orchestrator: UtilityProcess | null = null;
function startOrchestrator() {
  const entry = path.join(DIR, "orchestrator.js");
  orchestrator = utilityProcess.fork(entry, [], {
    stdio: "inherit",
    env: {
      ...process.env,
      // The orchestrator reads/writes the same config store as the renderer.
      FOVEA_DATA_PATH: DATA,
      // Boot-span baseline (docs/refactor/orchestrator.md §7.1 S5) — stamped
      // as close to `fork()` as possible so `index.ts` can measure fork ->
      // first-useful-work timing.
      FOVEA_FORK_TS: String(Date.now()),
    },
  });
  orchestrator.on("exit", (code) => {
    console.warn("Orchestrator exited:", code);
    orchestrator = null;
    // Every renderer's pending orchestrator requests would otherwise hang
    // forever (the crashed process can't reply) — notify them to reject
    // in-flight calls. See docs/refactor/orchestrator.md §12.1 C5.
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send("orchestrator:down");
  });
}

// A renderer asks to connect; hand both ends of a fresh channel out. Already
// generic per-`event.sender` — a second (profiler) window connecting just
// gets its own port pair, no changes needed for multi-window (§7.1 S4, the
// first real exercise of the multi-window brokering objective, §2).
ipcMain.on("orchestrator:connect", (event) => {
  if (!orchestrator) startOrchestrator();
  const { port1, port2 } = new MessageChannelMain();
  orchestrator!.postMessage(null, [port1]);
  event.sender.postMessage("orchestrator:port", null, [port2]);
});

// ---- Profiler window (§7.1 S4) --------------------------------------------
// A second, plain-chrome `BrowserWindow` loading the same renderer bundle
// with `?profiler=1` — `src/index.ts` branches on that to mount
// `ProfilerWindow.vue` instead of the main `App.vue`. Read-only over
// existing telemetry; needs no cameras, so it's usable during the mechanical
// downtime. Singleton — reopening focuses the existing one.
let profilerWin: BrowserWindow | null = null;
function openProfilerWindow() {
  if (profilerWin) {
    profilerWin.focus();
    return;
  }
  profilerWin = new BrowserWindow({
    title: "FoveaCam Duo — Profiler",
    icon: getIcon("icon.ico"),
    height: 800,
    width: 720,
    backgroundColor: "black",
    webPreferences: {
      preload: profilerPreload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  if (VITE_DEV_SERVER_URL) {
    profilerWin.loadURL(`${VITE_DEV_SERVER_URL}?profiler=1`);
  } else {
    profilerWin.loadFile(indexHtml, { search: "profiler=1" });
  }
  profilerWin.on("closed", () => {
    profilerWin = null;
  });
}

ipcMain.on("open-profiler-window", () => openProfilerWindow());

app.whenReady().then(customizeApp).then(startOrchestrator).then(createWindow);

// Terminate the orchestrator on quit (SIGTERM → its shutdown releases cameras,
// serial, and the native module). Without this it can outlive the app.
app.on("before-quit", () => {
  orchestrator?.kill();
  orchestrator = null;
});

app.on("window-all-closed", () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    createWindow();
  }
});

app.on("activate", () => {
  const allWindows = BrowserWindow.getAllWindows();
  if (allWindows.length) {
    allWindows[0].focus();
  } else {
    createWindow();
  }
});
