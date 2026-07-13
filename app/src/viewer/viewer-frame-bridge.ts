// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Viewer → projection frame bridge (viewer-tiles-split-and-project.md ruling 4).
// A projected viewer TILE mirrors exactly what the tile displays: the viewer
// renderer re-broadcasts the resolved Mat over a same-origin `BroadcastChannel`
// (one per app origin, shared across BrowserWindows), REF-COUNTED so the hot
// path stays untouched when nothing is projected. The publisher (viewer side)
// tracks which (recording,tileKey) pairs have a live subscriber and only the
// tiles it reports `wanted()` get serialized + posted. The subscriber
// (projection side) announces demand on open and re-announces on a ~1 s
// heartbeat, so a viewer that opens LATER still learns of the demand.
//
// Transport-shape only — no Vue, no DOM Mat coupling: `post` takes a plain
// `{ data, shape }` and the message carries a copied ArrayBuffer. Every
// `BroadcastChannel` access is lazy + guarded (undefined in SSR/test → no-op,
// never throws). Renderer-safe (no `core` import).
// spec: docs/spec/projection.md#viewer-source

/** The single same-origin channel every viewer publisher + projection
 *  subscriber shares (frames one way, subscribe/unsubscribe the other). */
export const VIEWER_FRAME_CHANNEL = "fovea:viewer-frames";

/** Heartbeat cadence for a subscriber re-announcing its demand (ms). */
const HEARTBEAT_MS = 1000;

/** Viewer → projection: one mirrored tile frame. The buffer is a COPY of the
 *  Mat's backing store (structured-cloned across the channel). */
export interface ViewerFrameMsg {
  type: "frame";
  recording: string;
  tileKey: string;
  width: number;
  height: number;
  channels: number;
  buffer: ArrayBuffer;
}

/** Projection → viewer: demand signalling. `id` (bridge-internal, optional on
 *  the wire) identifies the emitting subscriber so the publisher can ref-count
 *  DISTINCT live subscribers idempotently across heartbeats. */
export interface ViewerSubMsg {
  type: "subscribe" | "unsubscribe";
  recording: string;
  tileKey: string;
  id?: string;
}

type BridgeMsg = ViewerFrameMsg | ViewerSubMsg;

/** The `BroadcastChannel` constructor, or undefined where the platform lacks it
 *  (SSR / some test envs). Read lazily so the module imports without throwing. */
function broadcastCtor(): typeof BroadcastChannel | undefined {
  const g = globalThis as { BroadcastChannel?: typeof BroadcastChannel };
  return typeof g.BroadcastChannel === "function" ? g.BroadcastChannel : undefined;
}

function openChannel(): BroadcastChannel | null {
  const Ctor = broadcastCtor();
  if (!Ctor) return null;
  try {
    return new Ctor(VIEWER_FRAME_CHANNEL);
  } catch {
    return null;
  }
}

/** Keep a Node timer from pinning the event loop; harmless where `unref` is
 *  absent (browser `setInterval` returns a number). */
function unref(handle: unknown): void {
  const h = handle as { unref?: () => void } | null;
  if (h && typeof h.unref === "function") h.unref();
}

let subCounter = 0;
function freshSubId(): string {
  subCounter += 1;
  return `vsub-${Date.now().toString(36)}-${subCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export interface ViewerFramePublisher {
  /** Does any live subscriber currently want this tile's frames? */
  wanted(tileKey: string): boolean;
  /** Serialize + broadcast one tile frame (a buffer COPY). Callers should gate
   *  on `wanted(tileKey)` to keep the no-projection hot path free. */
  post(tileKey: string, mat: { data: Uint8Array; shape: readonly number[] }): void;
  /** Tear down the channel + listener. */
  dispose(): void;
}

/**
 * Viewer side. Owns the channel, tracks the set of live subscriber ids per
 * `tileKey` (ref-count of DISTINCT subscribers — idempotent under heartbeats),
 * and fires `onWantedChange` whenever a tile's demand toggles on/off so the
 * viewer can start/stop serializing.
 */
export function createViewerFramePublisher(
  recording: string,
  onWantedChange: () => void,
): ViewerFramePublisher {
  const channel = openChannel();
  // tileKey → set of live subscriber ids wanting it.
  const subs = new Map<string, Set<string>>();

  function wanted(tileKey: string): boolean {
    const set = subs.get(tileKey);
    return !!set && set.size > 0;
  }

  function onMessage(ev: MessageEvent<BridgeMsg>): void {
    const msg = ev.data;
    if (!msg || (msg.type !== "subscribe" && msg.type !== "unsubscribe")) return;
    if (msg.recording !== recording) return;
    const id = typeof msg.id === "string" && msg.id ? msg.id : msg.tileKey;
    const before = wanted(msg.tileKey);
    if (msg.type === "subscribe") {
      let set = subs.get(msg.tileKey);
      if (!set) subs.set(msg.tileKey, (set = new Set()));
      set.add(id);
    } else {
      const set = subs.get(msg.tileKey);
      if (set) {
        set.delete(id);
        if (set.size === 0) subs.delete(msg.tileKey);
      }
    }
    if (wanted(msg.tileKey) !== before) onWantedChange();
  }

  channel?.addEventListener("message", onMessage as EventListener);

  function post(tileKey: string, mat: { data: Uint8Array; shape: readonly number[] }): void {
    if (!channel) return;
    const height = mat.shape[0] ?? 0;
    const width = mat.shape[1] ?? 0;
    const px = width * height;
    const channels = px > 0 ? Math.round(mat.data.length / px) : 0;
    // Copy the exact view into a fresh ArrayBuffer (the Mat's buffer may be a
    // reused SHM read buffer / a sub-view — never post it live).
    const copy = mat.data.slice();
    const frame: ViewerFrameMsg = {
      type: "frame",
      recording,
      tileKey,
      width,
      height,
      channels,
      buffer: copy.buffer,
    };
    try {
      channel.postMessage(frame);
    } catch {
      /* channel closing / clone failure — drop this frame silently */
    }
  }

  function dispose(): void {
    channel?.removeEventListener("message", onMessage as EventListener);
    channel?.close();
    subs.clear();
  }

  return { wanted, post, dispose };
}

export interface ViewerFrameSubscription {
  close(): void;
}

/**
 * Projection side. Subscribe to one (recording,tileKey): announces demand on
 * open, re-announces on a heartbeat (so a later-opening viewer still sees it),
 * and invokes `onFrame` with each matching frame message. `close()`
 * unsubscribes and tears down.
 */
export function subscribeViewerFrame(
  recording: string,
  tileKey: string,
  onFrame: (m: ViewerFrameMsg) => void,
): ViewerFrameSubscription {
  const channel = openChannel();
  const id = freshSubId();

  function announce(type: "subscribe" | "unsubscribe"): void {
    if (!channel) return;
    const msg: ViewerSubMsg = { type, recording, tileKey, id };
    try {
      channel.postMessage(msg);
    } catch {
      /* ignore */
    }
  }

  function onMessage(ev: MessageEvent<BridgeMsg>): void {
    const msg = ev.data;
    if (!msg || msg.type !== "frame") return;
    if (msg.recording !== recording || msg.tileKey !== tileKey) return;
    onFrame(msg);
  }

  channel?.addEventListener("message", onMessage as EventListener);
  announce("subscribe");

  let beat: unknown = null;
  if (channel) {
    beat = setInterval(() => announce("subscribe"), HEARTBEAT_MS);
    unref(beat);
  }

  function close(): void {
    if (beat !== null) clearInterval(beat as ReturnType<typeof setInterval>);
    beat = null;
    announce("unsubscribe");
    channel?.removeEventListener("message", onMessage as EventListener);
    channel?.close();
  }

  return { close };
}
