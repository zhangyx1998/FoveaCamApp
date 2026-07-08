// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Live camera view session — validates the end-to-end frame path
// (utilityProcess → core acquisition → native Stream → frame transport →
// renderer). Opens the camera named by `state.serial` and republishes each
// frame on the `frame` channel. Switching serial tears down the previous loop.

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
      // Lease the shared camera; the registry opens + configures it once and
      // fans its preview to every viewer (this window, manage-cameras, the
      // projector). Retry with backoff: a camera mid-release by a
      // renderer-bound module briefly fails to open (RT1) even though it
      // becomes available again within a few seconds.
      const held = await retryUntil(() => acquire(serial));
      if (!held) return;
      // A newer serial may have superseded us while opening — honor it.
      if (s.state.serial !== serial) {
        held.release();
        return;
      }
      lease = held;
      // real-1c: the live view now rides the `camera:<serial>` native pipe;
      // the renderer reads it via `usePipeFrame`, not `s.frame("frame")`.
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
      // Resume the previously-selected stream when a window re-opens; release
      // the lease (the registry closes the camera if nobody else holds it)
      // when idle.
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
