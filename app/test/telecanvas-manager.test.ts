// Main-side TeleCanvas host lifecycle (standalone dual-mode module). The
// Electron fork/port/exit wiring is injected, so these cover the testable core:
//   • host spawn on mode=host, kill on mode=client, port-change re-spawn
//     (terminate-before-respawn), crash respawn while host, quit killAll;
//   • status snapshots (listening/port/urls per mode);
//   • reachable-URL enumeration from a fake networkInterfaces() shape.

import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import {
  TeleCanvasManager,
  reachableUrls,
  type HostHandle,
} from "../electron/telecanvas-manager";
import type { TeleCanvasStatus } from "@lib/telecanvas";

/** A fake host handle recording kills, plus the port it was forked on. */
function fakeHost(port: number) {
  return { port, killed: false, kill() { this.killed = true; } };
}

interface Harness {
  mgr: TeleCanvasManager;
  hosts: ReturnType<typeof fakeHost>[];
  statuses: TeleCanvasStatus[];
  last(): TeleCanvasStatus;
}

function harness(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {}): Harness {
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const statuses: TeleCanvasStatus[] = [];
  const mgr = new TeleCanvasManager({
    fork: (port) => {
      const h = fakeHost(port);
      hosts.push(h);
      return h as unknown as HostHandle;
    },
    interfaces: () => interfaces,
    onStatus: (s) => statuses.push(s),
  });
  return { mgr, hosts, statuses, last: () => statuses[statuses.length - 1] };
}

describe("reachableUrls", () => {
  it("lists localhost plus each non-internal IPv4", () => {
    const urls = reachableUrls(8100, {
      lo0: [
        { family: "IPv4", address: "127.0.0.1", internal: true } as NetworkInterfaceInfo,
      ],
      en0: [
        { family: "IPv4", address: "192.168.1.20", internal: false } as NetworkInterfaceInfo,
        { family: "IPv6", address: "fe80::1", internal: false } as NetworkInterfaceInfo,
      ],
      en1: [
        { family: "IPv4", address: "10.0.0.5", internal: false } as NetworkInterfaceInfo,
      ],
    });
    expect(urls).toEqual([
      "http://localhost:8100/",
      "http://192.168.1.20:8100/",
      "http://10.0.0.5:8100/",
    ]);
  });

  it("accepts the numeric family shape (older node)", () => {
    const urls = reachableUrls(80, {
      en0: [{ family: 4, address: "192.168.0.9", internal: false } as unknown as NetworkInterfaceInfo],
    });
    expect(urls).toEqual(["http://localhost:80/", "http://192.168.0.9:80/"]);
  });

  it("returns only localhost when there are no external IPv4s", () => {
    expect(reachableUrls(8100, {})).toEqual(["http://localhost:8100/"]);
  });
});

describe("TeleCanvasManager", () => {
  it("spawns the host in host mode and reports listening + urls", () => {
    const h = harness({
      en0: [
        { family: "IPv4", address: "192.168.1.5", internal: false } as NetworkInterfaceInfo,
      ],
    });
    h.mgr.apply("host", 8100);
    expect(h.hosts).toHaveLength(1);
    expect(h.hosts[0].port).toBe(8100);
    // Pre-listening status: host mode, not yet listening, no urls.
    expect(h.last()).toMatchObject({ mode: "host", listening: false, port: 8100, urls: [] });

    h.mgr.onListening(h.hosts[0] as unknown as HostHandle, 8100);
    expect(h.last()).toMatchObject({
      mode: "host",
      listening: true,
      port: 8100,
      urls: ["http://localhost:8100/", "http://192.168.1.5:8100/"],
      error: null,
    });
  });

  it("does not spawn a host in client mode", () => {
    const h = harness();
    h.mgr.apply("client", 8100);
    expect(h.hosts).toHaveLength(0);
    expect(h.last()).toMatchObject({ mode: "client", listening: false, port: null, urls: [] });
  });

  it("kills the host when switching host → client", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    h.mgr.onListening(h.hosts[0] as unknown as HostHandle, 8100);
    h.mgr.apply("client", 8100);
    expect(h.hosts[0].killed).toBe(true);
    expect(h.last()).toMatchObject({ mode: "client", listening: false, urls: [] });
  });

  it("re-spawns on a port change (terminate-before-respawn)", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    h.mgr.apply("host", 8200);
    expect(h.hosts).toHaveLength(2);
    expect(h.hosts[0].killed).toBe(true); // old killed before the new exists
    expect(h.hosts[1].port).toBe(8200);
  });

  it("is idempotent for the same host {mode, port}", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    h.mgr.apply("host", 8100);
    expect(h.hosts).toHaveLength(1); // no needless re-spawn
  });

  it("respawns after a host crash while still in host mode", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    // Crash: the host process exited on its own.
    h.mgr.onExit(h.hosts[0] as unknown as HostHandle);
    expect(h.hosts).toHaveLength(2); // respawned
    expect(h.last().error).toMatch(/restart/i);
  });

  it("does not respawn after an intentional kill (client switch)", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    const killed = h.hosts[0];
    h.mgr.apply("client", 8100); // kills the host
    // The dead process's exit event arrives after the kill — must NOT respawn.
    h.mgr.onExit(killed as unknown as HostHandle);
    expect(h.hosts).toHaveLength(1);
  });

  it("surfaces a listen error", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    h.mgr.onError(h.hosts[0] as unknown as HostHandle, "EADDRINUSE");
    expect(h.last()).toMatchObject({ listening: false, error: "EADDRINUSE" });
  });

  it("killAll kills the running host (app quit)", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    h.mgr.killAll();
    expect(h.hosts[0].killed).toBe(true);
  });

  it("ignores stale handle callbacks after a replace", () => {
    const h = harness();
    h.mgr.apply("host", 8100);
    const stale = h.hosts[0];
    h.mgr.apply("host", 8200); // replaces
    const before = h.statuses.length;
    // A late listening/error from the OLD host must not push status.
    h.mgr.onListening(stale as unknown as HostHandle, 8100);
    h.mgr.onError(stale as unknown as HostHandle, "boom");
    expect(h.statuses.length).toBe(before);
  });
});
