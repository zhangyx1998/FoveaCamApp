// Projection DnD intent + drop-zone geometry: the move/dup/app-window matrix
// and the VSCode-style edge-quadrant / center classification, as pure logic.

import { describe, expect, it } from "vitest";
import {
  dropEffectFor,
  dropZoneAt,
  effectAllowedFor,
  EDGE_FRACTION,
  isNoopDrop,
  PANE_MIME,
  resolveIntent,
} from "@lib/projection/dnd";

describe("resolveIntent (move/dup/app-window matrix)", () => {
  it("app origin is copy-only regardless of modifier", () => {
    expect(resolveIntent("app", { alt: false })).toBe("copy");
    expect(resolveIntent("app", { alt: true })).toBe("copy");
  });
  it("projection origin defaults to move, Alt = copy", () => {
    expect(resolveIntent("projection", { alt: false })).toBe("move");
    expect(resolveIntent("projection", { alt: true })).toBe("copy");
  });
});

describe("effectAllowed / dropEffect", () => {
  it("app windows advertise copy-only, projection windows copyMove", () => {
    expect(effectAllowedFor("app")).toBe("copy");
    expect(effectAllowedFor("projection")).toBe("copyMove");
  });
  it("dropEffect mirrors the resolved intent", () => {
    expect(dropEffectFor("projection", { alt: false })).toBe("move");
    expect(dropEffectFor("projection", { alt: true })).toBe("copy");
    expect(dropEffectFor("app", { alt: false })).toBe("copy");
  });
});

describe("dropZoneAt", () => {
  it("classifies the center", () => {
    expect(dropZoneAt(0.5, 0.5)).toBe("center");
  });
  it("classifies each edge band", () => {
    expect(dropZoneAt(0.02, 0.5)).toBe("left");
    expect(dropZoneAt(0.98, 0.5)).toBe("right");
    expect(dropZoneAt(0.5, 0.02)).toBe("top");
    expect(dropZoneAt(0.5, 0.98)).toBe("bottom");
  });
  it("uses the nearest edge inside the band", () => {
    // Closer to the top than the left.
    expect(dropZoneAt(0.2, 0.05)).toBe("top");
    // Closer to the left than the top.
    expect(dropZoneAt(0.05, 0.2)).toBe("left");
  });
  it("just inside the band is an edge; just outside is center", () => {
    expect(dropZoneAt(EDGE_FRACTION - 0.01, 0.5)).toBe("left");
    expect(dropZoneAt(EDGE_FRACTION + 0.01, 0.5)).toBe("center");
  });
  it("clamps out-of-range / NaN input", () => {
    expect(dropZoneAt(-1, 0.5)).toBe("left");
    expect(dropZoneAt(NaN, NaN)).toBe("center");
  });
});

describe("isNoopDrop", () => {
  it("a within-window move onto the same pane is a no-op", () => {
    expect(
      isNoopDrop({ intent: "move", sameWindow: true, draggedPaneId: "p", targetPaneId: "p" }),
    ).toBe(true);
  });
  it("a copy onto the same pane is a legitimate duplicate", () => {
    expect(
      isNoopDrop({ intent: "copy", sameWindow: true, draggedPaneId: "p", targetPaneId: "p" }),
    ).toBe(false);
  });
  it("a move onto a different pane, or cross-window, is not a no-op", () => {
    expect(
      isNoopDrop({ intent: "move", sameWindow: true, draggedPaneId: "p", targetPaneId: "q" }),
    ).toBe(false);
    expect(
      isNoopDrop({ intent: "move", sameWindow: false, draggedPaneId: "p", targetPaneId: "p" }),
    ).toBe(false);
  });
});

describe("PANE_MIME", () => {
  it("is a private, app-scoped subtype", () => {
    expect(PANE_MIME).toBe("application/x-fovea-pane+json");
  });
});
