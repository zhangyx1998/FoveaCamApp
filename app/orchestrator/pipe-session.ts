// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 pipe broker session (C-17) + the composition protocol (C-24 step 3). Advertises
// typed SHM pipes, brokers the one-time connectPipe/disconnectPipe handshake to the
// native publisher (refcount consumers), and materializes/tears down composed nodes on
// renderer demand. Nothing per-frame passes through here. Compose is two-mode:
// camera/-rooted (refcount, shared across windows) vs win/<windowId>/-rooted (window-
// owned, exclusive). Broker + materializers + window hooks are injected.
// spec: docs/spec/pipes.md#pipe-session

import { defineSession, type ServerSession } from "./runtime.js";
import type { Channel } from "@lib/orchestrator/protocol.js";
import {
  pipes,
  type PipeSpec,
  type PipeHandle,
  type PipeAdvert,
  type NodeAdvert,
  type ComposeRequest,
} from "@lib/orchestrator/pipe-contract.js";
import { nodeId } from "@lib/orchestrator/graph-contract.js";
import type { Rect } from "core/Geometry";

/** The publisher-broker surface the session drives — exactly the `core.Pipe`
 *  shape needed here (a subset of its exports). `advertise` returns the epoch. */
export interface PipeBroker {
  advertise(spec: PipeSpec): number;
  connect(pipeId: string): PipeHandle;
  disconnect(pipeId: string): number;
  drop(pipeId: string): void;
}

/** Adapt the native `core.Pipe` namespace to `PipeBroker`. The only seam
 *  divergence is `spec.dtype` (native types it as the raw schema `string`; the
 *  contract narrows to the schema `Dtype` — a trusted narrowing since the value
 *  came from the advertised spec). Pure identity at runtime; no core load. */
export const asBroker = (p: typeof import("core/Pipe")): PipeBroker =>
  p as unknown as PipeBroker;

/** One brick kind's lifecycle (C-24): `materialize` creates the node's
 *  producer/resources (e.g. fovea: advertise pipe + `attachFoveaPipe`) and
 *  returns its advert shape; `teardown` releases them (refs→0 / owner window
 *  closed). Registered per kind via `PipeSessionDeps.materializers`. */
export interface NodeMaterializer {
  /** May be async (e.g. the fovea brick reads the persisted calibration). */
  materialize(
    req: ComposeRequest,
  ): Pick<NodeAdvert, "kind" | "output"> | Promise<Pick<NodeAdvert, "kind" | "output">>;
  teardown(id: string): void;
}

export interface PipeSessionDeps {
  /** Pipes to advertise on build (e.g. static `camera/<serial>/convert`).
   *  Dynamic pipes are added later via the returned `advertise`/`unadvertise`. */
  specs?: PipeSpec[];
  /** The publisher broker — `asBroker(Pipe)` in production, a fake in tests. */
  broker: PipeBroker;
  /** Brick materializers by kind (C-24). Absent kind + camera-rooted id that is
   *  already advertised = ref-only compose (convert/undistort). */
  materializers?: Record<string, NodeMaterializer>;
  /** Authoritative caller identity (A-34: `hub.windowIdOf`). Absent (tests /
   *  legacy) → win/-rooted composes are rejected; camera-rooted refs pool
   *  under an anonymous ledger. */
  windowIdOf?(ch: Channel): string | undefined;
  /** Window-destroy signal (A-34: `hub.onWindowClosed`) — drives the auto
   *  unref/teardown. Returns a disposer. */
  onWindowClosed?(fn: (windowId: string) => void): () => void;
  /** Channel-close signal (value-sweep-2026-07-11: `hub.onChannelClosed`) —
   *  fires on every client port close (reload / crash / window close), which
   *  `onWindowClosed` does NOT (it's DESTROY-only, and reload keeps the
   *  windowId). Drives reconciliation of the per-channel `connectPipe` ledger
   *  so a leaked refcount can't wedge the C-21 consumer gate ON forever.
   *  Returns a disposer. */
  onChannelClosed?(fn: (ch: Channel) => void): () => void;
}

/** The pipe session + its dynamic-lifecycle controls (C-20). Sessions/tests
 *  drive `advertise`/`unadvertise` as pipes come and go; each mutates the
 *  seeded `state.pipes` Record so subscribed renderers react. */
export interface PipeSessionHandle {
  session: ServerSession<typeof pipes>;
  advertise(spec: PipeSpec): number; // returns the epoch
  unadvertise(pipeId: string): void;
  /** Live-advertised check — the fovea materializer resolves its CHAIN source
   *  with it (undistort brick live for the camera? else convert). */
  isAdvertised(pipeId: string): boolean;
}

const ANON = ""; // ledger key for calls without an authoritative windowId

type ComposedNode = {
  advert: NodeAdvert;
  /** Per-window ref counts (camera-rooted sharing; win-rooted always 1 key). */
  refs: Map<string, number>;
  /** True when a materializer created resources that need teardown at 0. */
  materialized: boolean;
};

export function pipeSession(deps: PipeSessionDeps): PipeSessionHandle {
  const { broker, specs = [], materializers = {} } = deps;
  const advertised: Record<string, PipeAdvert> = {};
  const composed = new Map<string, ComposedNode>();
  const nodeEpochs = new Map<string, number>(); // persists across teardown
  // value-sweep-2026-07-11 (`pipe-consumer-refcount-no-reconciliation`): raw
  // connect refcounts per channel, so a renderer that took `connectPipe` counts
  // and then went away (reload / crash / abrupt close) has them RECONCILED —
  // mirroring the composed-node ledger's window bookkeeping. Keyed by the
  // authoritative calling channel (from the command ctx). `channel → pipeId →
  // count`. A channel with no ctx (legacy path) isn't tracked (nothing to
  // reconcile — it never had a stable owner).
  const connectLedger = new Map<Channel, Map<string, number>>();
  let srv: ServerSession<typeof pipes>;

  /** Undo every outstanding raw connect a closing channel still holds — the
   *  balancing disconnect its `usePipeFrame` teardown never got to run. */
  function reconcileChannel(ch: Channel): void {
    const held = connectLedger.get(ch);
    if (!held) return;
    connectLedger.delete(ch);
    for (const [pipeId, count] of held)
      for (let i = 0; i < count; i++) broker.disconnect(pipeId);
  }
  deps.onChannelClosed?.(reconcileChannel);

  const push = () => srv.setState("pipes", { ...advertised });
  const pushNodes = () =>
    srv.setState(
      "nodes",
      Object.fromEntries([...composed].map(([id, n]) => [id, n.advert])),
    );

  const advertise = (spec: PipeSpec): number => {
    const epoch = broker.advertise(spec);
    advertised[spec.id] = { spec, epoch };
    push();
    return epoch;
  };
  const unadvertise = (pipeId: string): void => {
    broker.drop(pipeId);
    delete advertised[pipeId];
    push();
  };

  const totalRefs = (n: ComposedNode): number =>
    [...n.refs.values()].reduce((a, b) => a + b, 0);

  function teardown(id: string, n: ComposedNode): void {
    if (n.materialized) materializers[n.advert.kind]?.teardown(id);
    composed.delete(id);
  }

  function unref(id: string, windowKey: string): void {
    const n = composed.get(id);
    if (!n) return;
    const have = n.refs.get(windowKey) ?? 0;
    if (have <= 1) n.refs.delete(windowKey);
    else n.refs.set(windowKey, have - 1);
    if (totalRefs(n) === 0) teardown(id, n);
  }

  function onWindowClosed(windowId: string): void {
    let dirty = false;
    for (const [id, n] of [...composed]) {
      if (n.advert.owner === `win/${windowId}`) {
        teardown(id, n); // window-owned: dies with the window
        dirty = true;
      } else if (n.refs.has(windowId)) {
        n.refs.delete(windowId); // shared brick: drop ALL of this window's refs
        if (totalRefs(n) === 0) teardown(id, n);
        dirty = true;
      }
    }
    if (dirty) pushNodes();
  }
  deps.onWindowClosed?.(onWindowClosed);

  const session = defineSession("pipes", pipes, (s) => {
    srv = s;
    for (const spec of specs) {
      advertised[spec.id] = { spec, epoch: broker.advertise(spec) };
    }
    s.setState("pipes", { ...advertised });
    s.setState("nodes", {});
    return {
      commands: {
        async connectPipe(
          { pipeId }: { pipeId: string },
          ctx?: { channel: Channel },
        ): Promise<PipeHandle> {
          if (!advertised[pipeId])
            throw new Error(`pipes: unknown pipeId "${pipeId}"`);
          const handle = broker.connect(pipeId);
          // Record the connect against the caller so a channel close reconciles
          // it (the leak fix). No channel ctx = legacy/untracked — connect as
          // before, but it won't be auto-reconciled.
          const ch = ctx?.channel;
          if (ch) {
            let held = connectLedger.get(ch);
            if (!held) connectLedger.set(ch, (held = new Map()));
            held.set(pipeId, (held.get(pipeId) ?? 0) + 1);
          }
          return handle;
        },
        async disconnectPipe(
          { pipeId }: { pipeId: string },
          ctx?: { channel: Channel },
        ): Promise<void> {
          const ch = ctx?.channel;
          if (ch) {
            // Only release a count this channel actually holds — a double
            // disconnect (idempotent) must NOT decrement the native refcount
            // another window still relies on.
            const held = connectLedger.get(ch);
            const have = held?.get(pipeId) ?? 0;
            if (have <= 0) return;
            if (have <= 1) held!.delete(pipeId);
            else held!.set(pipeId, have - 1);
            if (held!.size === 0) connectLedger.delete(ch);
          }
          broker.disconnect(pipeId);
        },

        async compose(req: ComposeRequest, ctx?: { channel: Channel }): Promise<NodeAdvert> {
          const windowId = ctx ? deps.windowIdOf?.(ctx.channel) : undefined;
          const windowKey = windowId ?? ANON;
          const winRooted = req.id.startsWith("win/");
          if (winRooted) {
            // Exclusive, window-owned: the id must sit under the CALLER's
            // authoritative identity (no spoofing — A-34 tags the channel).
            if (!windowId)
              throw new Error(`compose: no window identity for "${req.id}"`);
            if (!req.id.startsWith(`win/${windowId}/`))
              throw new Error(
                `compose: "${req.id}" is outside the caller's namespace (win/${windowId}/)`,
              );
          } else if (!req.id.startsWith("camera/")) {
            throw new Error(
              `compose: "${req.id}" must be win/<caller>/-rooted or a camera/-rooted brick path`,
            );
          }

          const existing = composed.get(req.id);
          if (existing) {
            if (winRooted && existing.advert.owner !== `win/${windowId}`)
              throw new Error(`compose: "${req.id}" is owned by another window`);
            existing.refs.set(windowKey, (existing.refs.get(windowKey) ?? 0) + 1);
            return existing.advert;
          }

          // Materialize: by kind, or ref-only for a camera-rooted id that is
          // already an advertised pipe (convert/undistort — the C-21 gate parks
          // them; compose refs are pure bookkeeping).
          const materializer = materializers[req.kind];
          let shape: Pick<NodeAdvert, "kind" | "output">;
          let materialized = false;
          if (materializer) {
            shape = await materializer.materialize(req);
            materialized = true;
          } else if (!winRooted && advertised[req.id]) {
            const spec = advertised[req.id]!.spec;
            shape = {
              kind: req.kind,
              output: { kind: "frame", pixelFormat: spec.pixelFormat, dtype: spec.dtype },
            };
          } else {
            throw new Error(`compose: no materializer for kind "${req.kind}"`);
          }

          const epoch = (nodeEpochs.get(req.id) ?? 0) + 1;
          nodeEpochs.set(req.id, epoch);
          const advert: NodeAdvert = {
            ...shape,
            epoch,
            ...(winRooted ? { owner: `win/${windowId}` } : {}),
          };
          composed.set(req.id, {
            advert,
            refs: new Map([[windowKey, 1]]),
            materialized,
          });
          pushNodes();
          return advert;
        },

        async decompose({ id }: { id: string }, ctx?: { channel: Channel }): Promise<void> {
          const windowKey = (ctx ? deps.windowIdOf?.(ctx.channel) : undefined) ?? ANON;
          const before = composed.has(id);
          unref(id, windowKey);
          if (before) pushNodes();
        },
      },
    };
  });

  return {
    session,
    advertise,
    unadvertise,
    isAdvertised: (pipeId: string) => pipeId in advertised,
  };
}

// --- fovea crop brick materializer (C-24 step 4, re-chained per
// docs/proposals/unified-time-and-topology.md §5) --------------------------

/** The native fovea brick half the materializer drives —
 *  `Aravis.attachFoveaPipe`/`detachFoveaPipe` with a PIPE-ID source (the
 *  chained form: fovea crops the undistort/convert brick's frames; the legacy
 *  Camera-object source and its fused map-ROI `cal` are retired). Injected so
 *  the materializer and its vitest never load native core. */
export interface FoveaBrickSeam {
  attach(sourcePipeId: string, pipeId: string, options: { rect: Rect }): void;
  detach(pipeId: string): void;
}

export interface FoveaMaterializerDeps {
  /** The pipe session handle's dynamic-lifecycle controls — LAZY (the handle
   *  exists only after `pipeSession(...)` returns, but the materializer must
   *  be passed INTO it; materialize runs long after build, no TDZ). */
  pipes(): Pick<PipeSessionHandle, "advertise" | "unadvertise" | "isAdvertised">;
  brick: FoveaBrickSeam;
}

/**
 * Build the `fovea` NodeMaterializer: advertise the C-20 max-footprint pipe
 * and attach the native crop brick CHAINED on the camera's shared undistort
 * brick when one is live (a triple session advertised
 * `camera/<serial>/undistort`), else on the shared converter — uncalibrated
 * rigs degrade to converted-raw crops exactly like the old raw fallback. No
 * calibration loading: undistortion happens ONCE upstream in the chain (the
 * fused map-ROI path is retired natively). Teardown detaches the brick then
 * drops the pipe. C-20 churn semantics (max footprint, epoch bump on id
 * reuse, slot reuse) are carried by advertise/compose exactly as before.
 */
export function createFoveaMaterializer(deps: FoveaMaterializerDeps): NodeMaterializer {
  return {
    materialize(req: ComposeRequest): Pick<NodeAdvert, "kind" | "output"> {
      const serial = req.id.split("/")[1] ?? "";
      const pipes = deps.pipes();
      const undistortId = nodeId.undistort(serial);
      const convertId = nodeId.convert(serial);
      const source = pipes.isAdvertised(undistortId)
        ? undistortId
        : pipes.isAdvertised(convertId)
          ? convertId
          : null;
      // A fovea is composable only while its camera is live — the shared
      // converter pipe exists exactly while the camera is leased (registry).
      if (!source)
        throw new Error(
          `fovea: no live convert/undistort pipe for camera ${serial} (not leased?)`,
        );
      const p = (req.params ?? {}) as {
        rect?: Rect;
        maxWidth?: number;
        maxHeight?: number;
      };
      const rect = p.rect ?? { x: 0, y: 0, width: 256, height: 256 };
      const maxWidth = p.maxWidth ?? 512;
      const maxHeight = p.maxHeight ?? 512;
      const channels = 4;
      pipes.advertise({
        id: req.id,
        pixelFormat: "RGBA8",
        dtype: "U8",
        width: rect.width,
        height: rect.height,
        channels,
        stride: rect.width * channels,
        bytesPerFrame: rect.width * rect.height * channels,
        ringDepth: 4,
        maxWidth,
        maxHeight,
        maxBytes: maxWidth * maxHeight * channels,
      });
      deps.brick.attach(source, req.id, { rect });
      return { kind: "fovea", output: { kind: "frame", pixelFormat: "RGBA8", dtype: "U8" } };
    },
    teardown(id: string): void {
      deps.brick.detach(id);
      deps.pipes().unadvertise(id);
    },
  };
}
