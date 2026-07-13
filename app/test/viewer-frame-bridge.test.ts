// Viewer → projection frame bridge (viewer-tiles-split-and-project.md ruling 4):
// the BroadcastChannel transport that mirrors a viewer tile into a projection.
// Under test: ref-counted `wanted()` transitions (distinct subscribers,
// heartbeat idempotency), subscribe/unsubscribe round-trip, the frame message
// shape (dimensions + channels + a buffer COPY), (recording,tileKey) filtering,
// and the no-BroadcastChannel guard.
//
// vitest env is `node` (vitest.config.ts): Node ships a real BroadcastChannel,
// but its delivery is ASYNC — so we install a SYNCHRONOUS same-name stub for
// deterministic ref-count assertions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VIEWER_FRAME_CHANNEL,
  createViewerFramePublisher,
  subscribeViewerFrame,
  type ViewerFrameMsg,
  type ViewerSubMsg,
} from "@src/viewer/viewer-frame-bridge";

// --- synchronous BroadcastChannel stub --------------------------------------
type Listener = (ev: { data: unknown }) => void;
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  name: string;
  onmessage: Listener | null = null;
  private listeners = new Set<Listener>();
  private closed = false;
  constructor(name: string) {
    this.name = name;
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) FakeBroadcastChannel.channels.set(name, (set = new Set()));
    set.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) throw new Error("channel closed");
    const set = FakeBroadcastChannel.channels.get(this.name);
    if (!set) return;
    for (const ch of [...set]) {
      if (ch === this || ch.closed) continue; // BC never echoes to the sender
      ch.deliver(structuredClone(data)); // structured-clone copies the buffer
    }
  }
  private deliver(data: unknown): void {
    const ev = { data };
    this.onmessage?.(ev);
    for (const l of [...this.listeners]) l(ev);
  }
  addEventListener(type: string, fn: Listener): void {
    if (type === "message") this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    if (type === "message") this.listeners.delete(fn);
  }
  close(): void {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

const realBC = globalThis.BroadcastChannel;
beforeEach(() => {
  FakeBroadcastChannel.channels.clear();
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
});
afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = realBC;
});

/** A raw stub channel to drive subscribe/unsubscribe messages by hand. */
function rawChannel(): FakeBroadcastChannel {
  return new FakeBroadcastChannel(VIEWER_FRAME_CHANNEL);
}
function makeMatLike(len: number, h: number, w: number, fill = 7) {
  return { data: new Uint8Array(len).fill(fill), shape: [h, w] as const };
}

describe("createViewerFramePublisher — ref-counted wanted()", () => {
  it("wanted() flips true on the first subscriber, false when the last leaves; onWantedChange on each toggle", () => {
    const onWanted = vi.fn();
    const pub = createViewerFramePublisher("rec1", onWanted);
    expect(pub.wanted("center")).toBe(false);

    const sub = subscribeViewerFrame("rec1", "center", () => {});
    expect(pub.wanted("center")).toBe(true);
    expect(onWanted).toHaveBeenCalledTimes(1);

    sub.close();
    expect(pub.wanted("center")).toBe(false);
    expect(onWanted).toHaveBeenCalledTimes(2);
    pub.dispose();
  });

  it("two subscribers on one tile keep it wanted until BOTH leave (ref count > 1)", () => {
    const onWanted = vi.fn();
    const pub = createViewerFramePublisher("rec1", onWanted);
    const a = subscribeViewerFrame("rec1", "center", () => {});
    const b = subscribeViewerFrame("rec1", "center", () => {});
    expect(pub.wanted("center")).toBe(true);
    // Only ONE toggle (false→true); the second subscriber is not a transition.
    expect(onWanted).toHaveBeenCalledTimes(1);

    a.close();
    expect(pub.wanted("center")).toBe(true); // b still holds it
    expect(onWanted).toHaveBeenCalledTimes(1); // no toggle

    b.close();
    expect(pub.wanted("center")).toBe(false);
    expect(onWanted).toHaveBeenCalledTimes(2);
    pub.dispose();
  });

  it("heartbeat re-subscribe (same id) is idempotent — one unsubscribe clears demand", () => {
    const onWanted = vi.fn();
    const pub = createViewerFramePublisher("rec1", onWanted);
    const raw = rawChannel();
    const sub: ViewerSubMsg = { type: "subscribe", recording: "rec1", tileKey: "center", id: "S1" };
    raw.postMessage(sub);
    raw.postMessage(sub); // heartbeat: same id, must NOT double-count
    expect(pub.wanted("center")).toBe(true);
    expect(onWanted).toHaveBeenCalledTimes(1);

    raw.postMessage({ type: "unsubscribe", recording: "rec1", tileKey: "center", id: "S1" });
    expect(pub.wanted("center")).toBe(false);
    expect(onWanted).toHaveBeenCalledTimes(2);
    raw.close();
    pub.dispose();
  });

  it("ignores subscribe messages for a different recording", () => {
    const pub = createViewerFramePublisher("rec1", () => {});
    subscribeViewerFrame("rec2", "center", () => {});
    expect(pub.wanted("center")).toBe(false);
    pub.dispose();
  });
});

describe("frame message shape + delivery", () => {
  it("post() delivers a frame with derived dims/channels and a COPIED buffer", () => {
    const pub = createViewerFramePublisher("rec1", () => {});
    const received: ViewerFrameMsg[] = [];
    const sub = subscribeViewerFrame("rec1", "center", (m) => received.push(m));

    const mat = makeMatLike(24, 2, 3, 9); // 2×3 × 4ch = 24 bytes
    pub.post("center", mat);

    expect(received).toHaveLength(1);
    const msg = received[0]!;
    expect(msg.type).toBe("frame");
    expect(msg.recording).toBe("rec1");
    expect(msg.tileKey).toBe("center");
    expect(msg.width).toBe(3);
    expect(msg.height).toBe(2);
    expect(msg.channels).toBe(4); // 24 / (3*2)
    expect(new Uint8Array(msg.buffer)).toEqual(new Uint8Array(24).fill(9));
    // A copy: not the caller's backing buffer.
    expect(msg.buffer).not.toBe(mat.data.buffer);

    sub.close();
    pub.dispose();
  });

  it("only delivers frames matching the subscription's tileKey", () => {
    const pub = createViewerFramePublisher("rec1", () => {});
    const got: string[] = [];
    const sub = subscribeViewerFrame("rec1", "center", (m) => got.push(m.tileKey));
    pub.post("left", makeMatLike(4, 2, 2)); // other tile
    pub.post("center", makeMatLike(4, 2, 2)); // this tile
    expect(got).toEqual(["center"]);
    sub.close();
    pub.dispose();
  });
});

describe("no-BroadcastChannel guard (SSR / test env without the global)", () => {
  it("constructs + operates without throwing when BroadcastChannel is undefined", () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    expect(() => {
      const pub = createViewerFramePublisher("rec1", () => {});
      expect(pub.wanted("center")).toBe(false);
      pub.post("center", makeMatLike(4, 2, 2)); // no-op, no throw
      const sub = subscribeViewerFrame("rec1", "center", () => {});
      sub.close();
      pub.dispose();
    }).not.toThrow();
  });
});
