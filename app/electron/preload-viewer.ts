// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer-window preload, two jobs: install the shared `foveaBridge` and relay
// the brokered engine `MessagePort` from main into the page. Main delivers it via
// `webContents.postMessage("viewer:port", null, [port])`, arriving here on
// `ipcRenderer`; a DOM `MessagePort` can't cross `contextBridge`, so it's handed
// to the main world via `window.postMessage` (ViewerWindow.vue listens on the DOM
// `message` event). The engine itself is a MAIN-owned utilityProcess (Electron
// renderers can't construct Node workers).
// spec: docs/spec/viewer.md#topology
import { ipcRenderer } from "electron";
import { installBridge } from "./preload-bridge";

ipcRenderer.on("viewer:port", (e) => {
  window.postMessage("viewer:port", "*", e.ports);
});

installBridge();
