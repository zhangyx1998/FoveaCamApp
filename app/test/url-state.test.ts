// `@lib/url-state`: the
// state↔URL helper backing projection params and calibrate-extrinsic's
// wizard step. Node test env — `location`/`history` are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUrlParam, readUrlState, writeUrlState } from "@lib/url-state";

type Replaced = { url: string };

let replaced: Replaced[];

function stubLocation(url: string): void {
  const u = new URL(url);
  vi.stubGlobal("location", {
    get pathname() {
      return u.pathname;
    },
    get search() {
      return u.search;
    },
    get hash() {
      return u.hash;
    },
  });
  vi.stubGlobal("history", {
    state: null,
    replaceState(_state: unknown, _title: string, next: string) {
      replaced.push({ url: next });
      const nu = new URL(next, u.origin);
      u.pathname = nu.pathname;
      u.search = nu.search;
      u.hash = nu.hash;
    },
  });
}

beforeEach(() => {
  replaced = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("url-state", () => {
  it("reads params from the current URL", () => {
    stubLocation("http://x/windows/projection.html?session=disparity-scope&frame=C");
    expect(readUrlParam("session")).toBe("disparity-scope");
    expect(readUrlParam("frame")).toBe("C");
    expect(readUrlParam("missing")).toBeNull();
    expect(readUrlState()).toEqual({ session: "disparity-scope", frame: "C" });
  });

  it("merges a patch via replaceState, preserving unrelated params", () => {
    stubLocation("http://x/windows/calibrate-extrinsic.html?foo=1");
    writeUrlState({ step: "FIN" });
    expect(replaced).toHaveLength(1);
    expect(replaced[0].url).toBe("/windows/calibrate-extrinsic.html?foo=1&step=FIN");
  });

  it("null deletes a key", () => {
    stubLocation("http://x/p.html?step=FIN&foo=1");
    writeUrlState({ step: null });
    expect(replaced[0].url).toBe("/p.html?foo=1");
  });

  it("is idempotent — rewriting the same state never calls replaceState", () => {
    stubLocation("http://x/p.html?step=FIN");
    writeUrlState({ step: "FIN" });
    expect(replaced).toHaveLength(0); // no-op: safe to call from a reactive effect
    writeUrlState({ step: "PRV" });
    writeUrlState({ step: "PRV" });
    expect(replaced).toHaveLength(1);
  });
});
