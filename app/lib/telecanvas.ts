// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// TeleCanvas shared contract (standalone dual-mode module, user directive
// 2026-07-09). Pure data — Vue-free AND Node-free — so every consumer can load
// it: the renderer (config refs, the TeleCanvas window, the settings section),
// the typed IPC bridge (`electron/bridge.ts`), and the main-side host manager
// (`electron/telecanvas-manager.ts`).
//
// Two modes (config `tele_canvas_mode`):
//   • client — the app PUTs its merged projection SVG to a configured REMOTE
//     TeleCanvas server URL (`tele_canvas_url`). Current behavior, the default.
//   • host   — the app spins up its OWN TeleCanvas-compatible server (a
//     dependency-free node http server in a utilityProcess) on
//     `tele_canvas_port`; external displays open the served viewer page. The
//     push path is unchanged — it just targets `http://127.0.0.1:<port>/`.

export type TeleCanvasMode = "client" | "host";

/** Unprivileged default host port. The reference project defaults to 80, which
 *  needs root; 8100 avoids that and stays out of the common dev-server range. */
export const DEFAULT_TELECANVAS_PORT = 8100;

/** Host-server status the main-side manager pushes to every renderer (and
 *  answers `telecanvas:get-status` with). In client mode the host is off:
 *  `listening=false`, `port=null`, `urls=[]`. */
export interface TeleCanvasStatus {
  mode: TeleCanvasMode;
  /** The host http server is bound + accepting connections (host mode only). */
  listening: boolean;
  /** The port the host is (attempting to) listen on, or null in client mode. */
  port: number | null;
  /** Reachable viewer URLs while host+listening: `http://localhost:<port>/`
   *  plus one per external IPv4 the machine advertises. Empty otherwise. */
  urls: string[];
  /** Last host error (e.g. EADDRINUSE), or null. */
  error: string | null;
}

/** A fresh "client mode, nothing running" status — the pre-spawn default and
 *  what a client-mode manager reports. */
export const IDLE_TELECANVAS_STATUS: TeleCanvasStatus = {
  mode: "client",
  listening: false,
  port: null,
  urls: [],
  error: null,
};
