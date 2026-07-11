// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// manage-cameras session. Opens every connected camera, polls a live property
// snapshot (~1 Hz) into telemetry, and applies edits + the pixel-format
// reconfigure flow as commands, persisting to the shared config store.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { cameraConfigPath, cameraInfo, listCameraInfo } from "@orchestrator/camera";
import {
  acquire,
  acquireMany,
  retryUntil,
  type CameraLease,
} from "@orchestrator/registry";
import { read, update, write } from "@orchestrator/store-hub";
import { report } from "@orchestrator/diagnostics";
import { CAMERA_CONTROLS, describeCamera, readControlFields } from "@lib/camera-config";
import { manageCameras, type CameraView } from "./contract";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { Camera } from "core/Aravis";

/** Read a possibly-unavailable camera getter without throwing. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

type Entry = {
  lease: CameraLease;
  serial: string;
  role?: string;
};

export default function manageCamerasSession(): ServerSession<typeof manageCameras> {
  return defineSession("manage-cameras", manageCameras, (s) => {
    const entries = new Map<string, Entry>();
    let poll: ReturnType<typeof setInterval> | null = null;

    function readView(e: Entry): CameraView {
      const c = e.lease.camera;
      return {
        // MUST guard every native-handle read: a camera can be force-released
        // mid-poll, and an unguarded read on a released CoreObject throws
        // uncaught inside `setInterval` → orchestrator crash.
        description: safe(() => describeCamera(c), "Camera Not Connected"),
        role: e.role as CameraView["role"],
        pixel_format: safe(() => c.pixel_format, ""),
        pixel_format_options: safe(() => c.pixel_format_options, []),
        ...readControlFields(c as unknown as Record<string, any>, safe),
      };
    }

    function publishViews(): void {
      const views: Record<string, CameraView> = {};
      for (const [serial, e] of entries) {
        // Defense in depth: one bad entry drops from this tick instead of
        // killing the poll for every other camera.
        try {
          views[serial] = readView(e);
        } catch (err) {
          report(
            "manage-cameras",
            `readView ${serial}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      s.telemetry({ views });
    }

    async function registerEntry(serial: string, lease: CameraLease): Promise<void> {
      const config = await read<{ role?: string }>(
        cameraConfigPath(lease.camera),
        {},
      );
      entries.set(serial, { lease, serial, role: config.role });
      // The raw preview rides the `camera:<serial>` native pipe (renderer usePipeFrame).
    }

    async function openCamera(serial: string): Promise<void> {
      // Retry with backoff — a failure here is a still-settling handoff race
      // (RT1), not an absent camera (it was just listed).
      const lease = await retryUntil(() => acquire(serial));
      if (lease) await registerEntry(serial, lease);
      // Can't lease a just-listed camera → held by another process; surface it.
      else s.fail(`Camera ${serial} is in use by another process.`);
    }

    function closeEntry(serial: string): void {
      const e = entries.get(serial);
      if (!e) return;
      e.lease.release();
      entries.delete(serial);
    }

    const persist = (camera: Camera, patch: Record<string, unknown>) =>
      update(cameraConfigPath(camera), patch);

    async function refresh(): Promise<CameraInfo[]> {
      // Clear any prior contention error; a still-contended camera re-raises it.
      s.clearError();
      const found = await listCameraInfo();
      const present = new Set(found.map((c) => c.serial));
      const toOpen = found.map((c) => c.serial).filter((s) => !entries.has(s));
      if (toOpen.length > 0) {
        // One bulk discovery pass for the new cameras; per-serial retry only for
        // whichever ones a handoff race dropped.
        const leased = await acquireMany(toOpen);
        for (const [serial, lease] of leased) await registerEntry(serial, lease);
        for (const serial of toOpen)
          if (!entries.has(serial)) await openCamera(serial);
      }
      for (const serial of [...entries.keys()])
        if (!present.has(serial)) closeEntry(serial);
      const list = [...entries.values()].map((e) => cameraInfo(e.lease.camera));
      s.telemetry({ list });
      publishViews();
      poll ??= setInterval(publishViews, 1000);
      return list;
    }

    return {
      commands: {
        refresh,
        async set({ serial, key, value }) {
          const e = entries.get(serial);
          if (!e) return;
          const c = e.lease.camera;
          if (key === "role") {
            e.role = value as string | undefined;
          } else {
            try {
              // Inputs send correctly-typed values — assign straight through.
              (c as any)[key] = value;
            } catch (err) {
              console.error(`[manage-cameras] set ${key}:`, err);
              return; // don't persist a value the camera rejected
            }
          }
          await persist(c, { [key]: value });
          publishViews();
        },
        async setPixelFormat({ serial, format }) {
          const e = entries.get(serial);
          if (!e || format === e.lease.camera.pixel_format) return;
          const c = e.lease.camera;
          // `reconfigure` stops the shared loop before the mutate and restarts it
          // after (fresh buffer for the new payload size); retry the set to
          // absorb the cross-thread acquisition stop.
          await e.lease.reconfigure(async () => {
            let lastErr: unknown = null;
            for (let i = 0; i < 30; i++) {
              try {
                c.pixel_format = format as typeof c.pixel_format;
                lastErr = null;
                break;
              } catch (err) {
                lastErr = err;
                await new Promise((r) => setTimeout(r, 100));
              }
            }
            if (lastErr)
              console.error("[manage-cameras] set pixel format:", lastErr);
            else await persist(c, { pixel_format: format });
          });
          publishViews();
        },
        async reset({ serial }) {
          const e = entries.get(serial);
          if (!e) return;
          const c = e.lease.camera;
          const cam = c as unknown as Record<string, any>;
          try {
            // Schema-driven reset: frame rate to auto (enable off), each auto
            // control to a one-shot "Once", black level only when available.
            for (const ctrl of CAMERA_CONTROLS) {
              if (ctrl.enableKey) cam[ctrl.enableKey] = false;
              if (ctrl.autoKey) {
                if (ctrl.autoAvailableKey && !cam[ctrl.autoAvailableKey]) continue;
                cam[ctrl.autoKey] = "Once";
              }
            }
          } catch (err) {
            console.error("[manage-cameras] reset:", err);
          }
          e.role = undefined;
          await write(cameraConfigPath(c), {});
          publishViews();
        },
      },
      // Idle: stop the poll + release every camera; a later `refresh` re-opens.
      idle() {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        for (const serial of [...entries.keys()]) closeEntry(serial);
      },
    };
  });
}
