// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Controller-node NATIVE position input (native-compose-controller.md):
// attach-on-bind lifecycle, v1/unbound refusal (the session fallback owns
// those), TERMINATE + disable-iff-last on close, and detach on unbind — the
// FW5/quiesce-relevant JS half of the native pos_in path, driven with fake
// controllers (no native core loads).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControllerNode,
  resetControllerNodeForTest,
} from "@orchestrator/controller-node";
import { resetTopologyStateForTest } from "@orchestrator/graph-topology";

type Pos = { x: number; y: number };
const P = (x: number, y: number): Pos => ({ x, y });
const PAIR = (l: Pos, r: Pos) => ({ left: l, right: r });
const ORIGIN = PAIR(P(0, 0), P(0, 0));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A fake sink shaped like the native MirrorSink handle surface. */
function makeSinkHandle(streamId = 7) {
  const sink = { pos_in: { streamTag: "volts" }, released: false };
  return {
    sink,
    streamId,
    close: vi.fn(async () => {
      sink.released = true;
    }),
  };
}

function makeV2Controller() {
  const sinkHandles: Array<ReturnType<typeof makeSinkHandle>> = [];
  const c = {
    port: "/dev/v2",
    v2Capable: true,
    connected: true,
    enabled: false,
    enable: vi.fn(async () => {
      c.enabled = true;
    }),
    disable: vi.fn(async () => {
      c.enabled = false;
    }),
    predictVolts: vi.fn((p: { left: Pos; right: Pos }) => PAIR({ ...p.left }, { ...p.right })),
    createStream: vi.fn(),
    actuate: vi.fn(),
    createNativeMirrorSink: vi.fn(async (_initial: unknown, _nodeId?: string) => {
      const h = makeSinkHandle();
      sinkHandles.push(h);
      return h;
    }),
    sinkHandles,
  };
  return c;
}

let node: ControllerNode | null = null;
afterEach(() => {
  node?.dispose();
  node = null;
  resetControllerNodeForTest();
  resetTopologyStateForTest();
  vi.restoreAllMocks();
});

describe("openNativePosition", () => {
  it("attaches when a v2 controller is already bound (enable + sink + onAttach)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    node.bindController(c as never);
    const onAttach = vi.fn();
    const onDetach = vi.fn();
    const input = node.openNativePosition("disparity-scope", {
      initial: ORIGIN,
      onAttach,
      onDetach,
    });
    await tick();
    expect(c.enable).toHaveBeenCalled(); // enable-on-attach (JS input parity)
    expect(c.createNativeMirrorSink).toHaveBeenCalledWith(ORIGIN, "controller");
    expect(onAttach).toHaveBeenCalledWith(c.sinkHandles[0]!.sink);
    expect(input.sink).toBe(c.sinkHandles[0]!.sink);
    // The attached sink's MCU stream id is exposed (trigger-sync's CMD_FRAME target).
    expect(input.streamId).toBe(7);

    // Close: detach → TERMINATE (handle.close) → disable (we enabled, last out).
    await input.close();
    expect(input.streamId).toBeNull(); // detached — no stream to target
    expect(onDetach).toHaveBeenCalled();
    expect(c.sinkHandles[0]!.close).toHaveBeenCalled();
    expect(c.disable).toHaveBeenCalled();
  });

  it("attaches LATER when the controller binds after open (bind-lifecycle sync)", async () => {
    node = new ControllerNode();
    const onAttach = vi.fn();
    const input = node.openNativePosition("x", {
      initial: ORIGIN,
      onAttach,
      onDetach: vi.fn(),
    });
    await tick();
    expect(onAttach).not.toHaveBeenCalled(); // nothing bound yet
    expect(input.sink).toBeNull();
    expect(input.streamId).toBeNull(); // attach is lazy — no stream id yet

    const c = makeV2Controller();
    node.bindController(c as never);
    await tick();
    expect(onAttach).toHaveBeenCalled(); // attach rode bindController
    await input.close();
  });

  it("never attaches on a v1 controller (the session fallback owns v1)", async () => {
    node = new ControllerNode();
    const c = {
      port: "/dev/v1",
      v2Capable: false,
      connected: true,
      enabled: false,
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      predictVolts: vi.fn(),
      createStream: vi.fn(),
      actuate: vi.fn(async (p: unknown) => p),
      createNativeMirrorSink: vi.fn(),
    };
    node.bindController(c as never);
    const onAttach = vi.fn();
    const input = node.openNativePosition("x", {
      initial: ORIGIN,
      onAttach,
      onDetach: vi.fn(),
    });
    await tick();
    expect(onAttach).not.toHaveBeenCalled();
    expect(c.createNativeMirrorSink).not.toHaveBeenCalled();
    await input.close();
  });

  it("detaches on unbind (disconnect) and re-attaches on the next bind", async () => {
    node = new ControllerNode();
    const c1 = makeV2Controller();
    node.bindController(c1 as never);
    const onAttach = vi.fn();
    const onDetach = vi.fn();
    const input = node.openNativePosition("x", {
      initial: ORIGIN,
      onAttach,
      onDetach,
    });
    await tick();
    expect(onAttach).toHaveBeenCalledTimes(1);

    await node.unbindController(); // disconnect: detach + best-effort close
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(c1.sinkHandles[0]!.close).toHaveBeenCalled();
    expect(input.sink).toBeNull();
    // Unbind NEVER disables (hardware-quiescence ownership stays with the
    // session/janitor — the JS input invariant).
    expect(c1.disable).not.toHaveBeenCalled();

    const c2 = makeV2Controller();
    node.bindController(c2 as never); // reconnect: attach against the new device
    await tick();
    expect(onAttach).toHaveBeenCalledTimes(2);
    expect(input.sink).toBe(c2.sinkHandles[0]!.sink);
    await input.close();
  });

  it("suppresses the JS input's CMD_STREAM while a native attach is PENDING (dual-cmd-stream-handoff-race)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    c.createStream = vi.fn(async () => ({
      id: 0,
      update: vi.fn(),
      close: vi.fn(async () => {}),
    })) as never;
    // A SLOW native attach: the sink promise stays pending until we resolve it
    // — the exact window the JS fallback used to race a second CREATE into.
    let resolveAttach!: (h: ReturnType<typeof makeSinkHandle>) => void;
    c.createNativeMirrorSink = vi.fn(
      () => new Promise<ReturnType<typeof makeSinkHandle>>((r) => (resolveAttach = r)),
    ) as never;
    node.bindController(c as never);
    const native = node.openNativePosition("native", {
      initial: ORIGIN,
      onAttach: vi.fn(),
      onDetach: vi.fn(),
    });
    const js = node.openPosition("js-fallback", { initial: ORIGIN });
    // The fallback pumps updates DURING the pending attach (wave-5 fallback
    // loop shape) — the JS input must NOT lazily create its own stream.
    js.update(PAIR(P(1, 1), P(1, 1)));
    js.update(PAIR(P(2, 2), P(2, 2)));
    await tick();
    expect(c.createStream).not.toHaveBeenCalled();
    // Attach completes → still suppressed (native owns the wire).
    resolveAttach(makeSinkHandle());
    await tick();
    js.update(PAIR(P(3, 3), P(3, 3)));
    await tick();
    expect(c.createStream).not.toHaveBeenCalled();
    await native.close();
    await js.close();
  });

  it("TERMINATEs a pre-existing JS stream on native attach (explicit handoff)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    const jsStream = { id: 7, update: vi.fn(), close: vi.fn(async () => {}) };
    c.createStream = vi.fn(async () => jsStream) as never;
    node.bindController(c as never);
    // The JS input creates its stream FIRST (controller bound before any
    // native input existed — e.g. a pre-wave-5 style session, or the fallback
    // engaged while the controller was v2 but the native open came later).
    const js = node.openPosition("js-first", { initial: ORIGIN });
    js.update(PAIR(P(1, 1), P(1, 1)));
    await tick();
    expect(c.createStream).toHaveBeenCalledTimes(1);
    // Now the native input attaches → the node must hand off: the JS stream
    // is TERMINATEd BEFORE onAttach fires (never two live streams).
    const events: string[] = [];
    jsStream.close.mockImplementation(async () => {
      events.push("js-terminated");
    });
    const input = node.openNativePosition("native", {
      initial: ORIGIN,
      onAttach: () => events.push("attached"),
      onDetach: vi.fn(),
    });
    await tick();
    expect(events).toEqual(["js-terminated", "attached"]);
    // Post-handoff updates on the JS input stay streamless.
    js.update(PAIR(P(9, 9), P(9, 9)));
    await tick();
    expect(c.createStream).toHaveBeenCalledTimes(1);
    await input.close();
    await js.close();
  });

  it("disable waits for the LAST input across JS + native (quiesce parity)", async () => {
    node = new ControllerNode();
    const c = makeV2Controller();
    // Give the fake a working createStream for the JS input.
    c.createStream = vi.fn(async () => ({
      id: 0,
      update: vi.fn(),
      close: vi.fn(async () => {}),
    })) as never;
    node.bindController(c as never);
    const js = node.openPosition("js-input", { initial: ORIGIN });
    js.update(ORIGIN); // enable via the JS path
    await tick();
    const native = node.openNativePosition("native-input", {
      initial: ORIGIN,
      onAttach: vi.fn(),
      onDetach: vi.fn(),
    });
    await tick();
    await native.close();
    expect(c.disable).not.toHaveBeenCalled(); // the JS input is still open
    await js.close();
    expect(c.disable).toHaveBeenCalled(); // last one out disables
  });
});
