// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// TeleCanvas HOST server core — a dependency-free node http server (http + os
// only; express/ws are NOT available in this app). Wire-compatible with the
// reference TeleCanvas (github.com/zhangyx1998/TeleCanvas) on the PUSH side so
// any stock TeleCanvas-style pusher — including our own client-mode PUT — can
// push to it:
//
//   PUT /        content as plain-text body → store + broadcast → 200
//   GET /        a self-contained inline viewer HTML page (dark, the SVG filling
//                the viewport, EventSource subscription with reconnect)
//   GET /events  Server-Sent-Events stream: the current buffer on connect, then
//                every subsequent PUT (dependency-free + auto-reconnecting; the
//                reference uses WebSocket, but we serve our OWN viewer so SSE is
//                the simpler wire)
//   *            404
//
// The last buffer is held IN MEMORY only (the reference's buffer.txt persistence
// is deliberately NOT wanted — a fresh app start has fresh providers). CORS is
// permissive (Access-Control-Allow-Origin *, allow PUT) to match the reference.
//
// The request handling is factored so it is unit-testable by binding an
// ephemeral port (0); no Electron, no app dependencies.

import http from "node:http";
import type { AddressInfo } from "node:net";

// Same projection viewBox the in-app preview uses (RemoteCanvas): the PUT body
// is INNER svg markup, wrapped by the consumer in this frame.
const VIEW_BOX = "-240 -135 480 270";

/** The self-contained viewer page served at `GET /`. Dark background, the SVG
 *  filling the viewport, an EventSource subscription that JSON-decodes each
 *  frame (PUT bodies are multi-line SVG — JSON encoding keeps them intact across
 *  the single-line SSE `data:` field) and auto-reconnects. No external assets. */
function viewerPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>TeleCanvas</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d12; overflow: hidden; }
  #canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; }
  #canvas text { fill: #fff; dominant-baseline: middle; text-anchor: middle; }
  #status {
    position: fixed; left: 8px; bottom: 8px; font: 12px system-ui, sans-serif;
    color: #6b7280; opacity: 0.7; user-select: none; pointer-events: none;
  }
  #status.live { color: #34d399; }
</style>
</head>
<body>
<svg id="canvas" viewBox="${VIEW_BOX}" preserveAspectRatio="xMidYMid meet"></svg>
<div id="status">connecting…</div>
<script>
  var canvas = document.getElementById("canvas");
  var status = document.getElementById("status");
  var es = null;
  function connect() {
    es = new EventSource("/events");
    es.onopen = function () { status.className = "live"; status.textContent = "live"; };
    es.onmessage = function (e) {
      try { canvas.innerHTML = JSON.parse(e.data); } catch (err) {}
    };
    es.onerror = function () {
      status.className = ""; status.textContent = "reconnecting…";
      try { es.close(); } catch (err) {}
      setTimeout(connect, 1000);
    };
  }
  connect();
</script>
</body>
</html>
`;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/** A dependency-free, wire-compatible TeleCanvas host server. */
export class TeleCanvasServer {
  private readonly server: http.Server;
  private buffer = "";
  private readonly clients = new Set<http.ServerResponse>();

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    // A late socket error (client vanished mid-write) must never crash the host.
    this.server.on("clientError", (_err, socket) => socket.destroy());
  }

  /** Current in-memory buffer (last pushed content). */
  get content(): string {
    return this.buffer;
  }

  /** Number of connected SSE viewers. */
  get viewerCount(): number {
    return this.clients.size;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    const method = req.method ?? "GET";
    const url = (req.url ?? "/").split("?")[0];

    // CORS preflight.
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // PUT / — store + broadcast (wire-compatible with the reference / our client).
    if (method === "PUT" && (url === "/" || url === "")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.setContent(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });
      req.on("error", () => {
        res.writeHead(400);
        res.end();
      });
      return;
    }

    // GET / — the inline viewer page.
    if (method === "GET" && (url === "/" || url === "")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(viewerPage());
      return;
    }

    // GET /events — SSE stream: current buffer now, then every update.
    if (method === "GET" && url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Flush headers + the current buffer immediately so a fresh viewer paints
      // without waiting for the next PUT.
      res.write(sseFrame(this.buffer));
      this.clients.add(res);
      const drop = () => {
        this.clients.delete(res);
      };
      req.on("close", drop);
      res.on("error", drop);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  /** Replace the buffer and broadcast to every connected viewer. */
  private setContent(content: string): void {
    this.buffer = content;
    const frame = sseFrame(content);
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Bind the server. Resolves with the actual port (useful with port 0). */
  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve((this.server.address() as AddressInfo).port);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, host);
    });
  }

  /** Close the server + drop all viewers. Resolves once fully closed. */
  close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** One SSE frame carrying the (JSON-encoded) content. JSON encoding keeps
 *  multi-line SVG intact across the single-line `data:` field and matches the
 *  reference's `JSON.stringify(body)` wire shape. */
function sseFrame(content: string): string {
  return `data: ${JSON.stringify(content)}\n\n`;
}
