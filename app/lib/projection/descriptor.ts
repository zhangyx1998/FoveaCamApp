// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Projection split-view — pane descriptor codec: the VERSIONED serialize/parse
// boundary for a projectable pane's source ({kind:"frame",…} Channel ref or
// {kind:"pipe",id} advertised SHM pipe). Every decode is defensive (malformed /
// future-version → null, never throws) so a stale URL or foreign drag can't crash a
// window. Renderer- and main-safe (pure data + JSON); no Vue, no DOM.
// spec: docs/spec/projection.md#descriptor

/** Codec schema version. Bump on an incompatible shape change. The bump to 2
 *  ADDED the `viewer` source kind — a purely additive change: a v1 document's
 *  `frame`/`pipe` shapes are unchanged, so parsing ACCEPTS any version in
 *  `[1, PANE_CODEC_VERSION]` (`acceptsCodecVersion`). Still forward-incompatible
 *  by design — an OLD (v1-only) window must not misread a NEWER descriptor, and
 *  a future `> PANE_CODEC_VERSION` document is rejected here for the same reason. */
export const PANE_CODEC_VERSION = 2 as const;

/** Accept a serialized codec version: any known version up to the current one
 *  (additive kinds only, so an older document still decodes cleanly). */
function acceptsCodecVersion(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= PANE_CODEC_VERSION;
}

/** A Channel frame source — the classic projection path (passive `useSession`). */
export type FramePaneSource = { kind: "frame"; session: string; frame: string };
/** An advertised SHM pipe source — `usePipeFrame` over the pipes session. */
export type PipePaneSource = { kind: "pipe"; id: string };
/** A viewer TILE mirror source (viewer-tiles-split-and-project.md): the viewer
 *  re-broadcasts the Mat a tile currently displays over a `BroadcastChannel`,
 *  keyed by (`recording`, `tileKey`). `tileKey` is the viewer's stable per-tile
 *  key — a single channel name, or `pair:<base>` for a collapsed 3D tile — so
 *  the broadcast key tracks tile identity across scrub/reorder. */
export type ViewerPaneSource = { kind: "viewer"; recording: string; tileKey: string };
export type PaneSource = FramePaneSource | PipePaneSource | ViewerPaneSource;

/** One projectable pane: a stable id (unique within a window), its bound
 *  source, and optional presentation hints carried across a drag/reload. */
export type Pane = {
  id: string;
  source: PaneSource;
  /** Slim-header title (falls back to a source-derived label when absent). */
  title?: string;
  /** Accent color forwarded to the frame view outline (`--theme`). */
  theme?: string;
};

/** An id-less pane spec — what a StreamView/FrameView advertises for its
 *  projectable feed. The concrete `Pane` id is minted at open/drag time
 *  (`paneFromDescriptor`), so the source component never has to track one. */
export type PaneDescriptor = { source: PaneSource; title?: string; theme?: string };

/** Promote a descriptor to a full `Pane`, minting a fresh id. */
export function paneFromDescriptor(desc: PaneDescriptor): Pane {
  const pane: Pane = { id: freshPaneId(), source: desc.source };
  if (desc.title) pane.title = desc.title;
  if (desc.theme) pane.theme = desc.theme;
  return pane;
}

/** The transfer payload carried on a cross-window drag (custom MIME, see
 *  `dnd.ts`). Beyond the pane itself it records WHERE the drag started so the
 *  destination can tell a within-window move (→ tree move/swap) from a
 *  cross-window one (→ insert a fresh copy; the source removes its pane on a
 *  `move` dragend) and whether the origin is copy-only (an app window). */
export type PaneDragPayload = {
  pane: Pane;
  /** `?win=` id of the originating window (null for a pre-manager window). */
  srcWindowId: string | null;
  /** Origin class — an `app` window advertises copy-only (rigid layout). */
  origin: "app" | "projection";
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Validate + normalize an unknown value into a `PaneSource`, or null. */
export function parsePaneSource(v: unknown): PaneSource | null {
  if (!isObj(v)) return null;
  if (v.kind === "frame") {
    if (typeof v.session === "string" && typeof v.frame === "string" && v.session && v.frame)
      return { kind: "frame", session: v.session, frame: v.frame };
    return null;
  }
  if (v.kind === "pipe") {
    if (typeof v.id === "string" && v.id) return { kind: "pipe", id: v.id };
    return null;
  }
  if (v.kind === "viewer") {
    if (
      typeof v.recording === "string" && v.recording &&
      typeof v.tileKey === "string" && v.tileKey
    )
      return { kind: "viewer", recording: v.recording, tileKey: v.tileKey };
    return null;
  }
  return null;
}

/** Validate an unknown value into a `Pane` (source required, id defaulted when
 *  absent — a decoded pane without one still gets a stable local id). */
export function parsePaneObject(v: unknown): Pane | null {
  if (!isObj(v)) return null;
  const source = parsePaneSource(v.source);
  if (!source) return null;
  const pane: Pane = {
    id: typeof v.id === "string" && v.id ? v.id : freshPaneId(),
    source,
  };
  if (typeof v.title === "string") pane.title = v.title;
  if (typeof v.theme === "string") pane.theme = v.theme;
  return pane;
}

/** Serialize a single pane to a compact, URL-safe JSON string (the bridge
 *  single-pane open param). Versioned. */
export function serializePane(pane: Pane): string {
  return JSON.stringify({ v: PANE_CODEC_VERSION, pane: toWire(pane) });
}

/** Parse a `serializePane` string, or null on malformed / wrong-version input. */
export function parsePane(s: string | null | undefined): Pane | null {
  if (!s) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isObj(doc) || !acceptsCodecVersion(doc.v)) return null;
  return parsePaneObject(doc.pane);
}

/** Serialize a drag payload to the custom-MIME string (see `dnd.ts`). */
export function serializeDragPayload(payload: PaneDragPayload): string {
  return JSON.stringify({
    v: PANE_CODEC_VERSION,
    pane: toWire(payload.pane),
    srcWindowId: payload.srcWindowId,
    origin: payload.origin,
  });
}

/** Parse a drag-payload string, or null on malformed / wrong-version input. */
export function parseDragPayload(s: string | null | undefined): PaneDragPayload | null {
  if (!s) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isObj(doc) || !acceptsCodecVersion(doc.v)) return null;
  const pane = parsePaneObject(doc.pane);
  if (!pane) return null;
  const origin = doc.origin === "app" ? "app" : "projection";
  const srcWindowId = typeof doc.srcWindowId === "string" ? doc.srcWindowId : null;
  return { pane, srcWindowId, origin };
}

/** Drop the runtime-only fields; keep the wire shape minimal + stable. */
function toWire(pane: Pane): Record<string, unknown> {
  const w: Record<string, unknown> = { id: pane.id, source: pane.source };
  if (pane.title !== undefined) w.title = pane.title;
  if (pane.theme !== undefined) w.theme = pane.theme;
  return w;
}

let paneIdCounter = 0;
/** Mint a process-unique pane id (destination mints a fresh one on a
 *  cross-window insert so two windows' ids never collide). Not cryptographic —
 *  uniqueness within one renderer's lifetime is all a pane id needs. */
export function freshPaneId(): string {
  paneIdCounter += 1;
  return `pane-${Date.now().toString(36)}-${paneIdCounter.toString(36)}`;
}

/** A human label for a pane when it carries no explicit title — the source
 *  address, so an untitled pane header still names its feed. */
export function paneLabel(pane: Pane): string {
  if (pane.title) return pane.title;
  const s = pane.source;
  if (s.kind === "frame") return `${s.session} / ${s.frame}`;
  if (s.kind === "viewer") return `${s.recording} / ${s.tileKey}`;
  return s.id;
}

/** Structural identity of a pane's SOURCE (ignores id/title/theme) — used to
 *  detect a drop that would just re-bind the same feed. */
export function sameSource(a: PaneSource, b: PaneSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "frame" && b.kind === "frame")
    return a.session === b.session && a.frame === b.frame;
  if (a.kind === "pipe" && b.kind === "pipe") return a.id === b.id;
  if (a.kind === "viewer" && b.kind === "viewer")
    return a.recording === b.recording && a.tileKey === b.tileKey;
  return false;
}
