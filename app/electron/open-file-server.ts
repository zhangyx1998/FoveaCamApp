// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Unix-domain-socket listener the running main process owns so that opening a
// recording while the app is already up notifies THIS instance instead of
// spawning a second Electron (dev-mode file-association shim → forward.sh).
// PURE of Electron (node:net/fs/path only) so it unit-tests under vitest.
// Wire protocol: a client connects, writes newline-delimited absolute file
// paths, then half-closes; the server buffers the whole connection, splits on
// `end`, and invokes `onPath` once per non-empty trimmed line.
// spec: docs/dev/fcap-file-association.md

import net from "node:net";
import fs from "node:fs";

export interface OpenFileServer {
  close(): void;
}

/** Start the open-file socket listener at `socketPath`, invoking `onPath` for
 *  each newline-delimited path a client sends. A stale socket file from a
 *  crashed session is removed first so boot never blocks on it. */
export function startOpenFileServer(
  socketPath: string,
  onPath: (p: string) => void,
): OpenFileServer {
  fs.rmSync(socketPath, { force: true });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      for (const line of buffer.split("\n")) {
        const p = line.trim();
        if (p) onPath(p);
      }
      socket.end();
    });
  });
  server.on("error", () => {});
  server.listen(socketPath);

  return {
    close() {
      server.close();
      try {
        fs.rmSync(socketPath, { force: true });
      } catch {
        /* best effort */
      }
    },
  };
}
