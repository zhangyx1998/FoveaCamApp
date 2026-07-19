// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// TeleCanvas HOST utilityProcess entry (standalone dual-mode module). Main forks
// this (via `TeleCanvasManager`) whenever `tele_canvas_mode` is "host"; it starts
// the published `telecanvas` package server on the configured port, posts status
// to main over `process.parentPort` ({listening, port, error}), and exits cleanly
// on a `shutdown` message or parent death. Its own tiny entry (like probe.ts) so
// it pulls in no session graph / Hub — just the packaged server.
//
// No `persist` option on purpose: a fresh app start has fresh providers, so the
// canvas must start blank (the next PUT refills it — see Pusher's re-push on
// target re-announce).

import { createServer, type TeleCanvasServer } from "telecanvas";
import { DEFAULT_TELECANVAS_PORT } from "@lib/telecanvas.js";

const port = Number(process.env.FOVEA_TELECANVAS_PORT) || DEFAULT_TELECANVAS_PORT;

function post(message: unknown): void {
  try {
    process.parentPort.postMessage(message);
  } catch {
    /* parent may be gone */
  }
}

let server: TeleCanvasServer | null = null;
createServer({ port }).then(
  (s) => {
    server = s;
    post({ type: "telecanvas:listening", port: s.port });
  },
  (err: unknown) => {
    post({ type: "telecanvas:error", port, error: String((err as Error)?.message ?? err) });
  },
);

process.parentPort.on("message", (e) => {
  const data = e.data as { type?: string } | null;
  if (data?.type === "shutdown") {
    void (server?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  }
});
