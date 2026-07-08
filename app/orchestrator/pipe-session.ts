// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 pipe broker session (C-17). Advertises typed SHM pipes and brokers the
// one-time `connectPipe`/`disconnectPipe` handshake to the native `core.Pipe`
// publisher (refcount consumers). Nothing per-frame passes through here — once
// connected, the renderer reads pixels straight from the segment via the reader
// addon (`pipe-consumer.ts`).
//
// The broker is INJECTED (production passes `asBroker(Pipe)`), so vitest drives
// it with a fake and never loads native core — the session module carries only
// a type-level reference to `core/Pipe`. New C-owned module (C-16/C-17 grant).

import { defineSession, type ServerSession } from "./runtime.js";
import {
  pipes,
  type PipeSpec,
  type PipeHandle,
  type PipeAdvert,
} from "@lib/orchestrator/pipe-contract.js";

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

export interface PipeSessionDeps {
  /** Pipes to advertise on build (e.g. static `camera:<serial>`). Dynamic
   *  fovea pipes are added later via the returned `advertise`/`unadvertise`. */
  specs?: PipeSpec[];
  /** The publisher broker — `asBroker(Pipe)` in production, a fake in tests. */
  broker: PipeBroker;
}

/** The pipe session + its dynamic-lifecycle controls (C-20). A's tracking
 *  session (or a test) drives `advertise`/`unadvertise` as foveas come and go;
 *  each mutates the seeded `state.pipes` Record so subscribed renderers react. */
export interface PipeSessionHandle {
  session: ServerSession<typeof pipes>;
  advertise(spec: PipeSpec): number; // returns the epoch
  unadvertise(pipeId: string): void;
}

export function pipeSession(deps: PipeSessionDeps): PipeSessionHandle {
  const { broker, specs = [] } = deps;
  const advertised: Record<string, PipeAdvert> = {};
  let srv: ServerSession<typeof pipes>;

  const push = () => srv.setState("pipes", { ...advertised });

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

  const session = defineSession("pipes", pipes, (s) => {
    srv = s;
    for (const spec of specs) {
      advertised[spec.id] = { spec, epoch: broker.advertise(spec) };
    }
    s.setState("pipes", { ...advertised });
    return {
      commands: {
        async connectPipe({ pipeId }: { pipeId: string }): Promise<PipeHandle> {
          if (!advertised[pipeId])
            throw new Error(`pipes: unknown pipeId "${pipeId}"`);
          return broker.connect(pipeId);
        },
        async disconnectPipe({ pipeId }: { pipeId: string }): Promise<void> {
          broker.disconnect(pipeId);
        },
      },
    };
  });

  return { session, advertise, unadvertise };
}
