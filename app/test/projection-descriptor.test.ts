// Projection pane descriptor codec (docs/proposals/projection-split-view.md
// deliverable 3): versioned serialize/parse for a single pane and the DnD
// transfer payload, defensive against malformed / wrong-version input.

import { describe, expect, it } from "vitest";
import {
  PANE_CODEC_VERSION,
  paneLabel,
  parseDragPayload,
  parsePane,
  parsePaneObject,
  parsePaneSource,
  sameSource,
  serializeDragPayload,
  serializePane,
  freshPaneId,
  type Pane,
} from "@lib/projection/descriptor";

const framePane: Pane = {
  id: "p1",
  source: { kind: "frame", session: "disparity-scope", frame: "C" },
  title: "Center",
  theme: "orange",
};
const pipePane: Pane = { id: "p2", source: { kind: "pipe", id: "camera:123" } };

describe("parsePaneSource", () => {
  it("accepts a well-formed frame source", () => {
    expect(parsePaneSource({ kind: "frame", session: "s", frame: "f" })).toEqual({
      kind: "frame",
      session: "s",
      frame: "f",
    });
  });
  it("accepts a well-formed pipe source", () => {
    expect(parsePaneSource({ kind: "pipe", id: "camera:1" })).toEqual({
      kind: "pipe",
      id: "camera:1",
    });
  });
  it("rejects empty fields and unknown kinds", () => {
    expect(parsePaneSource({ kind: "frame", session: "", frame: "f" })).toBeNull();
    expect(parsePaneSource({ kind: "pipe", id: "" })).toBeNull();
    expect(parsePaneSource({ kind: "other" })).toBeNull();
    expect(parsePaneSource(null)).toBeNull();
    expect(parsePaneSource(42)).toBeNull();
  });
});

describe("serializePane / parsePane", () => {
  it("round-trips a frame pane with all fields", () => {
    const back = parsePane(serializePane(framePane));
    expect(back).toEqual(framePane);
  });
  it("round-trips a pipe pane without optional fields", () => {
    const back = parsePane(serializePane(pipePane));
    expect(back).toEqual(pipePane);
  });
  it("returns null on garbage / wrong version / empty", () => {
    expect(parsePane(null)).toBeNull();
    expect(parsePane("")).toBeNull();
    expect(parsePane("{not json")).toBeNull();
    expect(parsePane(JSON.stringify({ v: 999, pane: framePane }))).toBeNull();
    expect(parsePane(JSON.stringify({ v: PANE_CODEC_VERSION, pane: { source: {} } }))).toBeNull();
  });
  it("mints a fresh id when a decoded pane lacks one", () => {
    const s = JSON.stringify({
      v: PANE_CODEC_VERSION,
      pane: { source: { kind: "pipe", id: "x" } },
    });
    const p = parsePane(s);
    expect(p?.id).toBeTruthy();
    expect(p?.source).toEqual({ kind: "pipe", id: "x" });
  });
});

describe("parsePaneObject", () => {
  it("requires a valid source", () => {
    expect(parsePaneObject({ id: "a" })).toBeNull();
    expect(parsePaneObject({ id: "a", source: { kind: "frame", session: "s", frame: "f" } })).toMatchObject(
      { id: "a", source: { kind: "frame" } },
    );
  });
});

describe("serializeDragPayload / parseDragPayload", () => {
  it("round-trips pane + origin + srcWindowId", () => {
    const back = parseDragPayload(
      serializeDragPayload({ pane: framePane, srcWindowId: "app-3", origin: "app" }),
    );
    expect(back).toEqual({ pane: framePane, srcWindowId: "app-3", origin: "app" });
  });
  it("defaults origin to projection and srcWindowId to null on odd input", () => {
    const s = JSON.stringify({ v: PANE_CODEC_VERSION, pane: pipePane, origin: "bogus" });
    expect(parseDragPayload(s)).toEqual({ pane: pipePane, srcWindowId: null, origin: "projection" });
  });
  it("returns null on garbage / wrong version / bad pane", () => {
    expect(parseDragPayload(null)).toBeNull();
    expect(parseDragPayload("{")).toBeNull();
    expect(parseDragPayload(JSON.stringify({ v: 2, pane: framePane }))).toBeNull();
    expect(parseDragPayload(JSON.stringify({ v: PANE_CODEC_VERSION, pane: {} }))).toBeNull();
  });
});

describe("helpers", () => {
  it("paneLabel prefers the title, else derives from the source", () => {
    expect(paneLabel(framePane)).toBe("Center");
    expect(paneLabel({ ...framePane, title: undefined })).toBe("disparity-scope / C");
    expect(paneLabel(pipePane)).toBe("camera:123");
  });
  it("sameSource compares structural identity, ignoring id/title", () => {
    expect(sameSource(framePane.source, { kind: "frame", session: "disparity-scope", frame: "C" })).toBe(true);
    expect(sameSource(framePane.source, pipePane.source)).toBe(false);
    expect(sameSource(pipePane.source, { kind: "pipe", id: "camera:123" })).toBe(true);
  });
  it("freshPaneId yields distinct ids", () => {
    expect(freshPaneId()).not.toBe(freshPaneId());
  });
});
