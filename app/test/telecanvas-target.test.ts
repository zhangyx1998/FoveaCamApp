// TeleCanvas push-target resolver (standalone dual-mode module). `teleCanvasTarget`
// is the pure, SHARED WHERE-to-PUT logic the app-window `Pusher` uses — it must
// agree exactly with the reference so a host-mode push lands on this machine's
// own server and a client-mode push lands on the configured remote URL.
//
// This is the cross-instance fix's contract: main broadcasts the {mode, url,
// port} target to every window (the per-instance `["config"]` store-hub does not
// cross orchestrator instances), and the Pusher resolves it through THIS helper.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TELECANVAS_PORT,
  IDLE_TELECANVAS_TARGET,
  teleCanvasTarget,
} from "@lib/telecanvas";

describe("teleCanvasTarget", () => {
  it("host mode targets this machine's own server on the configured port", () => {
    expect(teleCanvasTarget({ mode: "host", url: "", port: 8100 })).toBe(
      "http://127.0.0.1:8100/",
    );
    expect(teleCanvasTarget({ mode: "host", url: "ignored", port: 9000 })).toBe(
      "http://127.0.0.1:9000/",
    );
  });

  it("host mode falls back to the default port when port is 0/NaN", () => {
    expect(teleCanvasTarget({ mode: "host", url: "", port: 0 })).toBe(
      `http://127.0.0.1:${DEFAULT_TELECANVAS_PORT}/`,
    );
    expect(
      teleCanvasTarget({ mode: "host", url: "", port: Number.NaN }),
    ).toBe(`http://127.0.0.1:${DEFAULT_TELECANVAS_PORT}/`);
  });

  it("client mode targets the configured remote URL", () => {
    expect(
      teleCanvasTarget({ mode: "client", url: "http://tv.local:8100/", port: 8100 }),
    ).toBe("http://tv.local:8100/");
  });

  it("client mode with an empty URL is disabled (empty target)", () => {
    expect(teleCanvasTarget({ mode: "client", url: "", port: 8100 })).toBe("");
  });

  it("the idle default is a disabled client target", () => {
    expect(IDLE_TELECANVAS_TARGET.mode).toBe("client");
    expect(teleCanvasTarget(IDLE_TELECANVAS_TARGET)).toBe("");
  });
});
