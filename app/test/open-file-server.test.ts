// Coverage for the PURE open-file socket listener (../electron/open-file-server)
// — the running-instance notify path behind the dev-mode file-association shim.
// Verifies chunk-split reassembly + ordering, stale-socket removal, close()
// unlink, and empty-line dropping. No Electron: node:net/fs only.

import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenFileServer, type OpenFileServer } from "../electron/open-file-server";

const dirs: string[] = [];
const servers: OpenFileServer[] = [];

function tmpSock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ofs-"));
  dirs.push(dir);
  return path.join(dir, "open-file.sock");
}

/** Wait for the listener to accept connections (listen() is async). */
function waitListening(sock: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryConnect = (attempts: number) => {
      const c = net.connect(sock);
      c.on("connect", () => {
        c.end();
        resolve();
      });
      c.on("error", (err) => {
        if (attempts <= 0) reject(err);
        else setTimeout(() => tryConnect(attempts - 1), 10);
      });
    };
    tryConnect(50);
  });
}

/** Connect, write `chunks` (each a separate write), half-close. */
function sendChunks(sock: string, chunks: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.connect(sock);
    c.on("error", reject);
    c.on("connect", () => {
      for (const chunk of chunks) c.write(chunk);
      c.end();
    });
    c.on("close", () => resolve());
  });
}

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("startOpenFileServer", () => {
  it("reassembles chunk-split paths and delivers them in order", async () => {
    const sock = tmpSock();
    const got: string[] = [];
    const server = startOpenFileServer(sock, (p) => got.push(p));
    servers.push(server);
    await waitListening(sock);

    // "/a/one.fcap\n/a/two.fcap\n" arriving across arbitrary chunk boundaries.
    await sendChunks(sock, ["/a/one.fca", "p\n/a/tw", "o.fcap\n"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["/a/one.fcap", "/a/two.fcap"]);
  });

  it("removes a stale regular file at the socket path and still listens", async () => {
    const sock = tmpSock();
    fs.writeFileSync(sock, "stale");
    expect(fs.statSync(sock).isFile()).toBe(true);

    const got: string[] = [];
    const server = startOpenFileServer(sock, (p) => got.push(p));
    servers.push(server);
    await waitListening(sock);

    await sendChunks(sock, ["/b/rec.fcap\n"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["/b/rec.fcap"]);
    expect(fs.statSync(sock).isSocket()).toBe(true);
  });

  it("close() unlinks the socket file", async () => {
    const sock = tmpSock();
    const server = startOpenFileServer(sock, () => {});
    await waitListening(sock);
    expect(fs.existsSync(sock)).toBe(true);
    server.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(sock)).toBe(false);
  });

  it("drops empty/whitespace lines", async () => {
    const sock = tmpSock();
    const got: string[] = [];
    const server = startOpenFileServer(sock, (p) => got.push(p));
    servers.push(server);
    await waitListening(sock);

    await sendChunks(sock, ["\n  \n/c/keep.fcap\n\n   \n"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["/c/keep.fcap"]);
  });
});
