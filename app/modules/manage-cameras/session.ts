// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// manage-cameras session. Opens every connected camera, polls a live property
// snapshot (~1 Hz) into telemetry, and applies edits + the pixel-format
// reconfigure flow as commands, persisting to the shared config store.
//
// Control edits (`set`) arrive per renderer input event — per MOUSEMOVE during
// a slider drag — so they go through a per-camera `CoalescedWriter`: one
// native write in flight per camera, intermediates dropped (final value always
// lands), store persistence debounced 300 ms trailing, and only the written
// control read back and patched into the last published snapshot. The full
// every-camera snapshot (`publishViews`) stays on the 1 Hz poll + structural
// events (refresh, setPixelFormat, reset, role change).

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
import {
  CAMERA_CONTROLS,
  describeCamera,
  readControlFields,
  readControlPatch,
} from "@lib/camera-config";
import { CoalescedWriter } from "@lib/coalesced-writer";
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
  writer: CoalescedWriter;
};

export default function manageCamerasSession(): ServerSession<typeof manageCameras> {
  return defineSession("manage-cameras", manageCameras, (s) => {
    const entries = new Map<string, Entry>();
    let poll: ReturnType<typeof setInterval> | null = null;
    let views: Record<string, CameraView> = {};

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
      const next: Record<string, CameraView> = {};
      for (const [serial, e] of entries) {
        // Defense in depth: one bad entry drops from this tick instead of
        // killing the poll for every other camera.
        try {
          next[serial] = readView(e);
        } catch (err) {
          report(
            "manage-cameras",
            `readView ${serial}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      views = next;
      s.telemetry({ views });
    }

    // Targeted read-back after one control write: re-read only that control's
    // field family on that camera and patch it into the last snapshot — never
    // a full every-camera poll per slider tick.
    function patchView(serial: string, camera: Camera, key: string): void {
      const patch = readControlPatch(camera as unknown as Record<string, any>, key, safe);
      const view = views[serial];
      if (!patch || !view) return publishViews();
      views[serial] = { ...view, ...patch };
      s.telemetry({ views });
    }

    async function registerEntry(serial: string, lease: CameraLease): Promise<void> {
      const camera = lease.camera;
      const configPath = cameraConfigPath(camera);
      const config = await read<{ role?: string }>(configPath, {});
      const writer = new CoalescedWriter({
        write: (key, value) => {
          // Inputs send correctly-typed values — assign straight through; a
          // throw means the camera refused it (never persisted).
          (camera as any)[key] = value;
        },
        onResult: (key, _value, error) => {
          if (error) console.error(`[manage-cameras] set ${key}:`, error);
          // Publish the read-back truth either way — on rejection this also
          // replaces the renderer's optimistic echo with the camera's value.
          patchView(serial, camera, key);
        },
        // configPath captured above: persistence must not touch the native
        // handle (flushes can outlive the lease).
        persist: (key, value) => update(configPath, { [key]: value }),
        onPersistError: (key, _value, err) =>
          report(
            "manage-cameras",
            `persist ${key}: ${err instanceof Error ? err.message : err}`,
          ),
      });
      entries.set(serial, { lease, serial, role: config.role, writer });
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
      // Drop queued writes, flush the debounced persists (store-only — safe
      // after release thanks to the captured config path).
      void e.writer.dispose();
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
          if (key === "role") {
            e.role = value as string | undefined;
            await persist(e.lease.camera, { role: value });
            publishViews();
            return;
          }
          // Fire-and-forget into the per-camera coalescer: per-mousemove
          // writes must not each block on a native write + store persist +
          // full snapshot re-read.
          e.writer.submit(key, value);
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
          // A queued drag value (or its debounced persist) must not land on
          // top of the reset.
          e.writer.clear();
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
