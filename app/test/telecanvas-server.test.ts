// Packaged `telecanvas` server — integration guard for the contract THIS APP
// relies on (the host utilityProcess forks `createServer`; app windows PUT to
// it cross-origin; the TeleCanvas window previews it via `telecanvas/vue`).
// Binds an ephemeral port (0) — localhost sockets are fine in vitest.
//   • PUT / with a raw text body stores + broadcasts (the Pusher wire).
//   • A WebSocket subscriber gets the current canvas on connect, then updates
//     (what TeleCanvasView renders).
//   • GET / serves a self-contained viewer page (external displays).
//   • CORS is permissive — the renderer's cross-origin fetch PUT depends on it.
//   • A bind conflict REJECTS createServer (the manager's EADDRINUSE path).

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, push, subscribe, type TeleCanvasServer } from "telecanvas";

let server: TeleCanvasServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(): Promise<number> {
  server = await createServer({ port: 0, host: "127.0.0.1" });
  return server.port;
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(method: string, path: string, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server!.port, path, method },
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

/** Subscribe like TeleCanvasView does and pull frames one at a time. */
function frames(port: number) {
  const queue: string[] = [];
  const waiters: Array<(v: string) => void> = [];
  const dispose = subscribe(`http://127.0.0.1:${port}/`, (svg) => {
    const w = waiters.shift();
    if (w) w(svg);
    else queue.push(svg);
  });
  return {
    next(): Promise<string> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise<string>((resolve) => waiters.push(resolve));
    },
    close: dispose,
  };
}

describe("packaged telecanvas server", () => {
  it("binds an ephemeral port and reports it", async () => {
    const port = await start();
    expect(port).toBeGreaterThan(0);
  });

  it("PUT / stores the raw text body (the Pusher wire)", async () => {
    await start();
    const res = await request("PUT", "/", "<circle r='5'/>");
    expect(res.status).toBe(200);
    expect(server!.content).toBe("<circle r='5'/>");
  });

  it("delivers the current canvas to a fresh subscriber, then each update", async () => {
    const port = await start();
    await push(`http://127.0.0.1:${port}/`, "<rect/>");
    const stream = frames(port);
    expect(await stream.next()).toBe("<rect/>");
    await request("PUT", "/", "<line/>");
    expect(await stream.next()).toBe("<line/>");
    stream.close();
  });

  it("GET / serves a self-contained viewer page", async () => {
    await start();
    const res = await request("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // Self-contained: no external asset references.
    expect(res.body).not.toMatch(/src=["']http/);
  });

  it("sets permissive CORS headers (the renderer PUTs cross-origin)", async () => {
    await start();
    const res = await request("GET", "/");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    const pre = await request("OPTIONS", "/");
    expect(pre.headers["access-control-allow-origin"]).toBe("*");
    expect(pre.headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("rejects createServer on a bind conflict (manager EADDRINUSE path)", async () => {
    const port = await start();
    await expect(createServer({ port, host: "127.0.0.1" })).rejects.toThrow();
  });
});
