// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// C-24 step 3: the compose/decompose protocol's TWO-MODE semantics (ruled) —
// win/-rooted = window-owned exclusive (authoritative identity, no spoofing);
// camera/-rooted = refcounted shared bricks (idempotent across windows;
// refs→0 tears down via the kind's materializer, or is pure bookkeeping for
// pre-advertised pipes); window close auto-unrefs. Driven over real Channel
// pairs with fake broker/materializers/window hooks — no native core.

import { describe, expect, it, vi } from "vitest";
import { Channel, topic } from "@lib/orchestrator/protocol";
import {
  pipeSession,
  type NodeMaterializer,
  type PipeBroker,
} from "@orchestrator/pipe-session";
import type { NodeAdvert, PipeSpec } from "@lib/orchestrator/pipe-contract";
import { createEndpointPair, flush } from "./fake-endpoint";

function spec(id: string): PipeSpec {
  return {
    id,
    pixelFormat: "BGRA8",
    dtype: "U8",
    width: 4,
    height: 4,
    channels: 4,
    stride: 16,
    bytesPerFrame: 64,
    ringDepth: 3,
  };
}

const fakeBroker = (): PipeBroker => ({
  advertise: vi.fn(() => 1),
  connect: vi.fn(),
  disconnect: vi.fn(() => 0),
  drop: vi.fn(),
}) as unknown as PipeBroker;

function harness(opts: { specs?: PipeSpec[]; materializers?: Record<string, NodeMaterializer> } = {}) {
  const windowByChannel = new Map<Channel, string>();
  let closeFn: ((windowId: string) => void) | null = null;
  const { session } = pipeSession({
    broker: fakeBroker(),
    specs: opts.specs,
    materializers: opts.materializers,
    windowIdOf: (ch) => windowByChannel.get(ch),
    onWindowClosed: (fn) => {
      closeFn = fn;
      return () => (closeFn = null);
    },
  });

  let nodes: Record<string, NodeAdvert> = {};
  function client(windowId?: string) {
    const [serverEp, clientEp] = createEndpointPair();
    const server = new Channel(serverEp);
    const clientCh = new Channel(clientEp);
    if (windowId) windowByChannel.set(server, windowId);
    session.attach(server);
    session.subscribe(server);
    clientCh.on(topic.state("pipes"), (patch: { key: string; value: never }) => {
      if (patch.key === "nodes") nodes = patch.value;
    });
    return {
      compose: (id: string, kind: string, inputs: Record<string, string> = {}) =>
        clientCh.request<NodeAdvert>(topic.command("pipes", "compose"), { id, kind, inputs }),
      decompose: (id: string) =>
        clientCh.request<void>(topic.command("pipes", "decompose"), { id }),
    };
  }
  return { client, nodes: () => nodes, closeWindow: (id: string) => closeFn?.(id) };
}

function foveaMaterializer() {
  const torn: string[] = [];
  const materializer: NodeMaterializer = {
    materialize: vi.fn((req) => ({
      kind: req.kind,
      output: { kind: "frame", pixelFormat: "BGRA8", dtype: "U8" },
    })),
    teardown: vi.fn((id) => torn.push(id)),
  };
  return { materializer, torn };
}

describe("compose protocol (C-24 step 3)", () => {
  it("win/-rooted: exclusive to the caller's AUTHORITATIVE namespace", async () => {
    const { materializer } = foveaMaterializer();
    const h = harness({ materializers: { display: materializer } });
    const w1 = h.client("tracking-1");
    const advert = await w1.compose("win/tracking-1/display", "display");
    expect(advert.owner).toBe("win/tracking-1");
    // Another window cannot compose into tracking-1's namespace…
    const w2 = h.client("manual-2");
    await expect(w2.compose("win/tracking-1/other", "display")).rejects.toThrow(/namespace/);
    // …and an identity-less channel cannot compose win/ at all.
    const anon = h.client();
    await expect(anon.compose("win/x/y", "display")).rejects.toThrow(/identity/);
  });

  it("camera/-rooted: refcounted + SHARED across windows; refs→0 tears down", async () => {
    const { materializer, torn } = foveaMaterializer();
    const h = harness({ materializers: { fovea: materializer } });
    const id = "camera/1/undistort/fovea/0";
    const w1 = h.client("multi-1");
    const w2 = h.client("tracking-2");
    const a1 = await w1.compose(id, "fovea");
    const a2 = await w2.compose(id, "fovea");
    expect(materializer.materialize).toHaveBeenCalledTimes(1); // shared brick
    expect(a1.epoch).toBe(a2.epoch);
    await w1.decompose(id);
    expect(torn).toEqual([]); // still ref'd by w2
    await w2.decompose(id);
    expect(torn).toEqual([id]); // refs→0 → teardown
    await flush();
    expect(h.nodes()[id]).toBeUndefined();
  });

  it("re-compose after teardown bumps the epoch (C-20 reuse-safe identity)", async () => {
    const { materializer } = foveaMaterializer();
    const h = harness({ materializers: { fovea: materializer } });
    const w = h.client("multi-1");
    const id = "camera/1/undistort/fovea/2";
    const first = await w.compose(id, "fovea");
    await w.decompose(id);
    const second = await w.compose(id, "fovea");
    expect(second.epoch).toBe(first.epoch + 1);
  });

  it("pre-advertised camera-rooted pipes compose ref-only (no materializer needed)", async () => {
    const h = harness({ specs: [spec("camera/1/convert")] });
    const w = h.client("viewer-1");
    const advert = await w.compose("camera/1/convert", "convert");
    expect(advert.output).toMatchObject({ kind: "frame", pixelFormat: "BGRA8" });
    // Unknown kind with no materializer AND no advertised pipe → rejected.
    await expect(w.compose("camera/1/undistort/fovea/9", "fovea")).rejects.toThrow(/materializer/);
  });

  it("window close auto-unrefs shared bricks and tears down win/ nodes", async () => {
    const { materializer, torn } = foveaMaterializer();
    const h = harness({ materializers: { fovea: materializer, display: materializer } });
    const w1 = h.client("multi-1");
    const w2 = h.client("other-2");
    await w1.compose("camera/1/undistort/fovea/0", "fovea");
    await w2.compose("camera/1/undistort/fovea/0", "fovea");
    await w1.compose("win/multi-1/kernel", "display");
    h.closeWindow("multi-1");
    // The win/ node dies with its window; the shared fovea survives on w2's ref.
    expect(torn).toEqual(["win/multi-1/kernel"]);
    h.closeWindow("other-2");
    expect(torn).toEqual(["win/multi-1/kernel", "camera/1/undistort/fovea/0"]);
  });

  it("ids outside both namespaces are rejected", async () => {
    const h = harness();
    const w = h.client("w-1");
    await expect(w.compose("bogus/thing", "x")).rejects.toThrow(/rooted/);
  });
});
