// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Controller session. Wraps the orchestrator-owned serial controller behind the
// `controller` contract. Idle until `connect` is commanded; the title-bar
// `Controller.vue` (a thin client over this session) connects on mount and is
// the sole owner of the serial device.

import { defineSession, type ServerSession } from "../runtime.js";
import {
  Controller,
  activeController,
  setActiveController,
} from "../controller.js";
import { controller } from "@lib/orchestrator/contracts";

const NEUTRAL = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

export function controllerSession(): ServerSession<typeof controller> {
  return defineSession("controller", controller, (s) => {
    // The active device lives in the shared holder so control-loop sessions
    // actuate the same hardware; this session owns its connect/disconnect.
    const ctrl = () => activeController();

    function publish(): void {
      const c = ctrl();
      s.telemetry({
        connected: !!c?.connected,
        enabled: !!c?.enabled,
        dv: c?.dv ?? 0,
        pos: c?.pos ?? NEUTRAL,
      });
    }

    return {
      commands: {
        async connect() {
          if (ctrl()) return true;
          s.telemetry({ pending: true });
          try {
            const info = await Controller.match({
              vendorId: s.state.vendorId,
              productId: s.state.productId,
            });
            if (!info) return false;
            const c = new Controller(info);
            await c.ready;
            setActiveController(c);
            publish();
            return true;
          } finally {
            s.telemetry({ pending: false });
          }
        },
        async disconnect() {
          const c = ctrl();
          setActiveController(null);
          c?.release();
          publish();
        },
        async enable() {
          await ctrl()?.enable();
          publish();
        },
        async disable() {
          await ctrl()?.disable();
          publish();
        },
        async actuate(arg) {
          const c = ctrl();
          if (!c) throw new Error("Controller not connected");
          const res = await c.actuate(arg, arg.settle_time);
          s.telemetry({ pos: { left: res.left, right: res.right } });
          return res;
        },
        async trigger(ns) {
          await ctrl()?.trigger(ns);
        },
        async setBias(v) {
          return (await ctrl()?.setBias(v)) ?? 0;
        },
        async setLPF(v) {
          await ctrl()?.setLPF(v);
          return v;
        },
      },
    };
  });
}
