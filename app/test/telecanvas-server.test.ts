// TeleCanvas HOST server core (standalone dual-mode module). Binds an ephemeral
// port (0) — localhost sockets are fine in vitest — and exercises the wire:
// PUT / stores + broadcasts, GET /events delivers the initial buffer then each
// update, GET / returns the self-contained viewer page, unknown paths 404, and
// CORS is permissive (matching the reference so a stock TeleCanvas pusher works).

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { TeleCanvasServer } from "../electron/telecanvas-server";

let server: TeleCanvasServer | null = null;
let port = 0;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(): Promise<number> {
  server = new TeleCanvasServer();
  port = await server.listen(0, "127.0.0.1");
  return port;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  method: string,
  path: string,
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open an SSE stream and yield decoded frames (JSON-decoded content) as they
 *  arrive, via a small pull API. */
function sse(path: string) {
  const frames: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  let buf = "";
  const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const m = raw.match(/^data: (.*)$/s);
        if (!m) continue;
        const decoded = JSON.parse(m[1]) as string;
        const w = waiters.shift();
        if (w) w(decoded);
        else frames.push(decoded);
      }
    });
  });
  return {
    next(): Promise<string> {
      const queued = frames.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    close() {
      req.destroy();
    },
  };
}

describe("TeleCanvasServer", () => {
  it("GET / returns the self-contained viewer page", async () => {
    await start();
    const res = await request("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("EventSource");
    expect(res.body).toContain('viewBox="-240 -135 480 270"');
    // Self-contained: no external asset references.
    expect(res.body).not.toMatch(/src=["']http/);
  });

  it("PUT / stores the buffer and responds 200", async () => {
    await start();
    const res = await request("PUT", "/", "<circle r='5'/>");
    expect(res.status).toBe(200);
    expect(server!.content).toBe("<circle r='5'/>");
  });

  it("GET /events sends the current buffer immediately, then each update", async () => {
    await start();
    await request("PUT", "/", "<rect/>");
    const stream = sse("/events");
    // Initial buffer on connect.
    expect(await stream.next()).toBe("<rect/>");
    // A subsequent PUT broadcasts to the open viewer.
    await request("PUT", "/", "<line/>");
    expect(await stream.next()).toBe("<line/>");
    stream.close();
  });

  it("delivers an empty initial buffer to a fresh viewer", async () => {
    await start();
    const stream = sse("/events");
    expect(await stream.next()).toBe("");
    stream.close();
  });

  it("404s an unknown path", async () => {
    await start();
    const res = await request("GET", "/nope");
    expect(res.status).toBe(404);
  });

  it("sets permissive CORS headers (allow-origin *, PUT method)", async () => {
    await start();
    const res = await request("GET", "/");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("PUT");
    // Preflight is answered 204.
    const pre = await request("OPTIONS", "/");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
  });

  it("listen(0) resolves the actual bound port", async () => {
    const p = await start();
    expect(p).toBeGreaterThan(0);
  });
});
