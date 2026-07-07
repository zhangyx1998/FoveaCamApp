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
  MessageChannelMain,
  type UtilityProcess,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
// │ └── windows/*.html      (multi-window entries, docs/refactor/multi-window.md;
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const preload = {
  renderer: path.join(DIR, "preload-renderer.cjs"),
  profiler: path.join(DIR, "preload-profiler.cjs"),
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

/** File→Open Recording… (A-11): `.fovea` filter, one viewer window per file
 *  (a re-open of an already-viewed file focuses its window). */
async function openRecordingDialog(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: "Open Recording",
    filters: [{ name: "FoveaCam Recording", extensions: ["fovea"] }],
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

// ---- Renderer bridge handlers (docs/refactor/orchestrator.md §7.1 T5) -----
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
  return file;
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
  orchestrator.on("message", (data: unknown) => {
    const msg = data as { type?: string; id?: number; ok?: boolean; reason?: string };
    if (msg?.type !== "window:drain-result" || msg.id === undefined) return;
    pendingDrains.get(msg.id)?.({ ok: !!msg.ok, reason: msg.reason });
    pendingDrains.delete(msg.id);
  });
  orchestrator.on("exit", (code) => {
    console.warn("Orchestrator exited:", code);
    orchestrator = null;
    // A dead orchestrator has nothing left to drain — unblock any switch
    // waiting on it rather than letting it time out.
    for (const [id, resolve] of pendingDrains) {
      resolve({ ok: true });
      pendingDrains.delete(id);
    }
    // Every renderer's pending orchestrator requests would otherwise hang
    // forever (the crashed process can't reply) — notify them to reject
    // in-flight calls. See docs/refactor/orchestrator.md §12.1 C5.
    for (const w of BrowserWindow.getAllWindows())
      pushTo(w.webContents, "orchestrator:down");
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

// A renderer asks to connect; hand both ends of a fresh channel out. Already
// generic per-`event.sender` — every window class connecting just gets its
// own port pair (§7.1 S4 / multi-window per-window handshake).
ipcMain.on("orchestrator:connect" satisfies keyof SendChannels, (event) => {
  if (!orchestrator) startOrchestrator();
  const { port1, port2 } = new MessageChannelMain();
  orchestrator!.postMessage(null, [port1]);
  event.sender.postMessage("orchestrator:port", null, [port2]);
});

// ---- Window manager (docs/refactor/multi-window.md §3) --------------------

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
  });
  // App windows maximize by default (legacy behavior) unless restoring bounds.
  if (desc.class === "app" && !desc.bounds) win.maximize();

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
      // (docs/refactor/recorder-container.md).
      pushTo(win.webContents, "recorder:trigger");
    }
  });

  const managed: ManagedWindow = {
    class: desc.class,
    appId: desc.appId,
    fileKey: desc.fileKey,
    owner: desc.owner, // WS2 2a: parent pointer (set by 2b's sub-window opener)
    key: desc.key, // WS2 2a: toggle dedupe key
    focus: () => {
      if (win.isMinimized()) win.restore();
      win.focus();
    },
    close: () => win.close(),
    isDestroyed: () => win.isDestroyed(),
    getURL: () => win.webContents.getURL(),
    getBounds: () => win.getBounds(),
  };
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
  // `app.exit()` skips `before-quit`, so release the orchestrator explicitly.
  orchestrator?.kill();
  orchestrator = null;
  app.exit(0);
}

// ---- File association (A-11, recorder-container.md §4) --------------------
// macOS delivers double-clicked/dragged `.fovea` files via `open-file` —
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
  .then(customizeApp)
  .then(startOrchestrator)
  .then(createInitialWindows);

// Terminate the orchestrator on quit (SIGTERM → its shutdown releases cameras,
// serial, and the native module). Without this it can outlive the app.
app.on("before-quit", () => {
  manager.markQuitting();
  orchestrator?.kill();
  orchestrator = null;
});

app.on("window-all-closed", () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", (_e, commandLine = []) => {
  // Windows/Linux file association: a second launch with `.fovea` args
  // lands here (single-instance lock) — open viewers instead of focusing.
  const files = commandLine.filter((arg) => arg.toLowerCase().endsWith(".fovea"));
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
