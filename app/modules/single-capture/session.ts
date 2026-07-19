// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Live camera view session — validates the end-to-end frame path. Opens the
// camera named by `state.serial`; switching serial tears down the previous lease.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { listCameraInfo } from "@orchestrator/camera";
import { acquire, retryUntil, type CameraLease } from "@orchestrator/registry";
import { liveview } from "./contract";

export default function liveViewSession(): ServerSession<typeof liveview> {
  return defineSession("liveview", liveview, (s) => {
    let lease: CameraLease | null = null;

    async function stream(serial: string): Promise<void> {
      lease?.release();
      lease = null;
      if (!serial) return;
      // Lease the shared camera (the registry fans its preview to every viewer).
      // Retry with backoff — a camera mid-release briefly fails to open.
      const held = await retryUntil(() => acquire(serial));
      if (!held) return;
      // A newer serial may have superseded us while opening — honor it.
      if (s.state.serial !== serial) {
        held.release();
        return;
      }
      lease = held;
      // The live view rides the `camera:<serial>` native pipe (renderer usePipeFrame).
    }

    return {
      commands: {
        async refresh() {
          const cameras = await listCameraInfo();
          s.telemetry({ cameras });
          return cameras;
        },
      },
      watch: {
        serial: (value) => void stream(value),
      },
      // Resume the selected stream on re-open; release the lease when idle.
      activate() {
        if (s.state.serial) void stream(s.state.serial);
      },
      idle() {
        lease?.release();
        lease = null;
      },
    };
  });
}
