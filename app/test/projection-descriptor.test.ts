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
const viewerPane: Pane = {
  id: "p3",
  source: { kind: "viewer", recording: "rec-a.fcap", tileKey: "pair:cam0" },
  title: "Left/Right",
  theme: "cyan",
};

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
  it("accepts a well-formed viewer source", () => {
    expect(
      parsePaneSource({ kind: "viewer", recording: "rec.fcap", tileKey: "center" }),
    ).toEqual({ kind: "viewer", recording: "rec.fcap", tileKey: "center" });
  });
  it("rejects empty fields and unknown kinds", () => {
    expect(parsePaneSource({ kind: "frame", session: "", frame: "f" })).toBeNull();
    expect(parsePaneSource({ kind: "pipe", id: "" })).toBeNull();
    expect(parsePaneSource({ kind: "other" })).toBeNull();
    expect(parsePaneSource(null)).toBeNull();
    expect(parsePaneSource(42)).toBeNull();
  });
  it("rejects a viewer source with empty / non-string recording or tileKey", () => {
    expect(parsePaneSource({ kind: "viewer", recording: "", tileKey: "c" })).toBeNull();
    expect(parsePaneSource({ kind: "viewer", recording: "r", tileKey: "" })).toBeNull();
    expect(parsePaneSource({ kind: "viewer", recording: "r" })).toBeNull();
    expect(parsePaneSource({ kind: "viewer", recording: 5, tileKey: "c" })).toBeNull();
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
  it("round-trips a viewer pane with all fields", () => {
    const back = parsePane(serializePane(viewerPane));
    expect(back).toEqual(viewerPane);
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
    expect(parseDragPayload(JSON.stringify({ v: 999, pane: framePane }))).toBeNull();
    expect(parseDragPayload(JSON.stringify({ v: PANE_CODEC_VERSION, pane: {} }))).toBeNull();
  });
});

describe("codec version 2 (additive viewer source, v1 back-compat)", () => {
  it("PANE_CODEC_VERSION is 2", () => {
    expect(PANE_CODEC_VERSION).toBe(2);
  });
  it("serializePane stamps the current version", () => {
    const doc = JSON.parse(serializePane(viewerPane));
    expect(doc.v).toBe(2);
  });
  it("still parses a v1 frame pane (additive bump — old descriptors accepted)", () => {
    const v1 = JSON.stringify({ v: 1, pane: { id: "p1", source: framePane.source } });
    expect(parsePane(v1)).toEqual({ id: "p1", source: framePane.source });
  });
  it("still parses a v1 drag payload", () => {
    const v1 = JSON.stringify({ v: 1, pane: pipePane, srcWindowId: "w1", origin: "app" });
    expect(parseDragPayload(v1)).toEqual({ pane: pipePane, srcWindowId: "w1", origin: "app" });
  });
  it("rejects a future version above the current one", () => {
    expect(parsePane(JSON.stringify({ v: 3, pane: viewerPane }))).toBeNull();
  });
});

describe("helpers", () => {
  it("paneLabel prefers the title, else derives from the source", () => {
    expect(paneLabel(framePane)).toBe("Center");
    expect(paneLabel({ ...framePane, title: undefined })).toBe("disparity-scope / C");
    expect(paneLabel(pipePane)).toBe("camera:123");
    expect(paneLabel({ ...viewerPane, title: undefined })).toBe("rec-a.fcap / pair:cam0");
  });
  it("sameSource compares structural identity, ignoring id/title", () => {
    expect(sameSource(framePane.source, { kind: "frame", session: "disparity-scope", frame: "C" })).toBe(true);
    expect(sameSource(framePane.source, pipePane.source)).toBe(false);
    expect(sameSource(pipePane.source, { kind: "pipe", id: "camera:123" })).toBe(true);
    expect(sameSource(viewerPane.source, { kind: "viewer", recording: "rec-a.fcap", tileKey: "pair:cam0" })).toBe(true);
    expect(sameSource(viewerPane.source, { kind: "viewer", recording: "rec-a.fcap", tileKey: "center" })).toBe(false);
    expect(sameSource(viewerPane.source, pipePane.source)).toBe(false);
  });
  it("freshPaneId yields distinct ids", () => {
    expect(freshPaneId()).not.toBe(freshPaneId());
  });
});
