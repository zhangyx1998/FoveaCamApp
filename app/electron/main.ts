// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { app, BrowserWindow, shell } from "electron";
// import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getIcon } from "./util";

const DIR = path.dirname(fileURLToPath(import.meta.url));

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
const preload = path.join(DIR, "preload.mjs");
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
            // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
            nodeIntegration: true,
            // Consider using contextBridge.exposeInMainWorld
            // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
            contextIsolation: false,
        },
    });

    // Show window when ready to avoid white/black flash
    // win.once("ready-to-show", () => win.show());

    if (VITE_DEV_SERVER_URL) {
        win.loadURL(VITE_DEV_SERVER_URL);
        // Open devTool if the app is not packaged
        win.webContents.openDevTools();
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

app.whenReady().then(customizeApp).then(createWindow);

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
