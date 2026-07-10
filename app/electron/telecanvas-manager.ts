// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main-side TeleCanvas HOST lifecycle (standalone dual-mode module). Owns the
// desired {mode, port} and the single host utilityProcess:
//   • mode=host → spawn the host on `port`; a port change re-spawns it
//     (terminate-before-respawn, mirroring ViewerEngineManager's discipline).
//   • mode=client/off → kill the host.
//   • host crash while mode=host → respawn with a status push.
// It also computes the reachable viewer URLs (localhost + each external IPv4)
// and pushes a `TeleCanvasStatus` to the renderer on every change.
//
// Electron-free: the fork/port/exit wiring is INJECTED (`fork`, `interfaces`,
// `onStatus`) so the state machine is unit-testable without the Electron runtime
// (test/telecanvas-manager.test.ts) — same pattern as viewer-engine.ts.

import type { NetworkInterfaceInfo } from "node:os";
import {
  DEFAULT_TELECANVAS_PORT,
  type TeleCanvasMode,
  type TeleCanvasStatus,
} from "@lib/telecanvas.js";

/** A live host process as the manager sees it — the Electron fork/port wiring is
 *  hidden behind this by `fork`. */
export interface HostHandle {
  /** Terminate the host process (idempotent). */
  kill(): void;
}

export interface TeleCanvasManagerDeps {
  /** Fork + wire a host process on `port`; the returned handle's later
   *  listening/error/exit are reported back via the manager's `on*` methods. */
  fork(port: number): HostHandle;
  /** `os.networkInterfaces()` (injected for testable URL enumeration). */
  interfaces(): NodeJS.Dict<NetworkInterfaceInfo[]>;
  /** Push a fresh status to the renderer (a bridge broadcast in main.ts). */
  onStatus(status: TeleCanvasStatus): void;
}

/** Reachable viewer URLs for a listening host: `http://localhost:<port>/` plus
 *  one per NON-internal IPv4 the machine advertises. Pure — unit-tested with a
 *  fake `networkInterfaces()` shape. */
export function reachableUrls(
  port: number,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string[] {
  const urls = [`http://localhost:${port}/`];
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      // `family` is "IPv4" on modern node, 4 on older — accept both.
      const isV4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (isV4 && !info.internal) urls.push(`http://${info.address}:${port}/`);
    }
  }
  return urls;
}

export class TeleCanvasManager {
  private mode: TeleCanvasMode = "client";
  private port = DEFAULT_TELECANVAS_PORT;
  private host: HostHandle | null = null;
  private listening = false;
  private lastError: string | null = null;

  constructor(private readonly deps: TeleCanvasManagerDeps) {}

  /** Apply a desired {mode, port}. Idempotent: host mode (re)spawns only when
   *  there is no host yet or the port changed; client mode kills any host. */
  apply(mode: TeleCanvasMode, port: number): void {
    const portChanged = port !== this.port;
    this.mode = mode;
    this.port = port;
    if (mode !== "host") {
      this.stopHost();
      this.lastError = null; // a client switch clears any host error
      this.pushStatus();
      return;
    }
    if (!this.host || portChanged) this.spawnHost();
    else this.pushStatus();
  }

  /** The host reported it is listening. */
  onListening(handle: HostHandle, port: number): void {
    if (handle !== this.host) return; // stale (already replaced/killed)
    this.listening = true;
    this.lastError = null;
    this.port = port;
    this.pushStatus();
  }

  /** The host reported a listen error (e.g. EADDRINUSE). */
  onError(handle: HostHandle, error: string): void {
    if (handle !== this.host) return;
    this.listening = false;
    this.lastError = error;
    this.pushStatus();
  }

  /** The host process exited. If it was the current host and we still want a
   *  host, respawn (crash recovery); an intentional kill already dropped it. */
  onExit(handle: HostHandle): void {
    if (handle !== this.host) return; // an intentional kill / replaced handle
    this.host = null;
    this.listening = false;
    if (this.mode === "host") {
      // Respawn (crash recovery) but KEEP the "restarting" note so the renderer
      // shows why the server briefly dropped — the fresh listen clears it.
      this.spawnHost("host server exited — restarting");
    } else {
      this.pushStatus();
    }
  }

  /** Current status snapshot (answers `telecanvas:get-status`). */
  status(): TeleCanvasStatus {
    const host = this.mode === "host";
    return {
      mode: this.mode,
      listening: host && this.listening,
      port: host ? this.port : null,
      urls:
        host && this.listening
          ? reachableUrls(this.port, this.deps.interfaces())
          : [],
      error: this.lastError,
    };
  }

  /** Kill the host (app quit). */
  killAll(): void {
    this.stopHost();
  }

  /** (Re)spawn the host. `error` carries a status note through the respawn (the
   *  crash-recovery "restarting" message); omit it for a clean user-driven
   *  spawn, which clears any stale error. Terminate-before-respawn discipline. */
  private spawnHost(error: string | null = null): void {
    this.stopHost(); // terminate-before-respawn
    this.listening = false;
    this.lastError = error;
    this.host = this.deps.fork(this.port);
    this.pushStatus();
  }

  private stopHost(): void {
    if (this.host) {
      this.host.kill();
      this.host = null;
    }
    this.listening = false;
  }

  private pushStatus(): void {
    this.deps.onStatus(this.status());
  }
}
