// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Renderer facade for the orchestrator controller session, matching the
// `getController()` interface (dv / enabled / pos / actuate / enable / disable /
// trigger). `Controller.vue` wraps this in an app-lifetime singleton and is the
// sole consumer, so the renderer no longer owns the serial device — the
// orchestrator's controller session does. Other modules read it via
// `getController()` as before.

import { computed, toRef } from "vue";
import { useSession } from "./orchestrator/client";
import { controller } from "./orchestrator/contracts";
import type { Pos } from "./controller-codec";

export type ControllerFacade = {
  readonly dv: number;
  readonly enabled: boolean;
  readonly pos: { left: Pos; right: Pos };
  enable(): Promise<void>;
  disable(): Promise<void>;
  actuate(p: {
    left?: Pos;
    right?: Pos;
    settle_time?: number;
  }): Promise<{ left: Pos; right: Pos; complete_time: number }>;
  trigger(duration_ns: number): Promise<void>;
};

export function useControllerClient() {
  const session = useSession(controller, "controller");
  const { telemetry } = session;
  const connected = toRef(telemetry, "connected");
  const enabled = toRef(telemetry, "enabled");
  const pending = toRef(telemetry, "pending");
  const dv = toRef(telemetry, "dv");
  const pos = toRef(telemetry, "pos");

  // Mirrors `getController()`: a facade while connected, else null.
  const facade = computed<ControllerFacade | null>(() =>
    connected.value
      ? {
          get dv() {
            return dv.value;
          },
          get enabled() {
            return enabled.value;
          },
          get pos() {
            return pos.value;
          },
          enable: () => session.call("enable", undefined),
          disable: () => session.call("disable", undefined),
          actuate: (p) => session.call("actuate", p),
          trigger: (ns) => session.call("trigger", ns),
        }
      : null,
  );

  return {
    controller: facade,
    connected,
    pending,
    vendorId: toRef(session.state, "vendorId"),
    productId: toRef(session.state, "productId"),
    connect: () => session.call("connect", undefined),
    disconnect: () => session.call("disconnect", undefined),
    setBias: (v: number) => session.call("setBias", v),
    setLPF: (v: number) => session.call("setLPF", v),
  };
}
