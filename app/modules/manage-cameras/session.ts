// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// manage-cameras session. The orchestrator opens every connected camera,
// streams a preview per serial (dynamic frame channel), polls a live property
// snapshot into telemetry, and applies edits / the pixel-format reconfigure flow
// as commands — persisting changes to the shared config store.

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
import { describeCamera } from "@lib/camera-config";
import { manageCameras, type CameraView, type Range } from "./contract";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { Camera } from "core/Aravis";

const ZERO_RANGE: Range = { min: 0, max: 0 };

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
        // `describeCamera`/`pixel_format` touch the native handle same as
        // every other getter here — guard them too. A camera can be
        // force-released (§12.1 C2, `system.releaseCameras`) while this 1 Hz
        // poll is scheduled; an unguarded read on a released `CoreObject`
        // throws and, uncaught inside `setInterval`, would crash the
        // orchestrator process.
        description: safe(() => describeCamera(c), "Camera Not Connected"),
        role: e.role as CameraView["role"],
        pixel_format: safe(() => c.pixel_format, ""),
        pixel_format_options: safe(() => c.pixel_format_options, []),
        frame_rate_available: safe(() => c.frame_rate_available, false),
        frame_rate_enable: safe(() => c.frame_rate_enable, false),
        frame_rate: safe(() => c.frame_rate, 0),
        frame_rate_range: safe(() => c.frame_rate_range, ZERO_RANGE),
        exposure_auto_available: safe(() => c.exposure_auto_available, false),
        exposure_auto: safe(() => c.exposure_auto, "Off"),
        exposure: safe(() => c.exposure, 0),
        exposure_range: safe(() => c.exposure_range, ZERO_RANGE),
        gain_auto_available: safe(() => c.gain_auto_available, false),
        gain_auto: safe(() => c.gain_auto, "Off"),
        gain: safe(() => c.gain, 0),
        gain_range: safe(() => c.gain_range, ZERO_RANGE),
        black_level_available: safe(() => c.black_level_available, false),
        black_level_auto_available: safe(
          () => c.black_level_auto_available,
          false,
        ),
        black_level_auto: safe(() => c.black_level_auto, "Off"),
        black_level: safe(() => c.black_level, 0),
        black_level_range: safe(() => c.black_level_range, ZERO_RANGE),
      };
    }

    function publishViews(): void {
      const views: Record<string, CameraView> = {};
      for (const [serial, e] of entries) {
        // Defense in depth on top of the per-getter guards in `readView`: one
        // bad entry (e.g. closed mid-poll) drops from this tick's snapshot
        // instead of killing the poll for every other camera.
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
      lease.onFrame((payload) => s.frame(serial, payload));
    }

    async function openCamera(serial: string): Promise<void> {
      // The registry opens + applies stored config; we just lease and view.
      // Retry with backoff: this serial was just seen in `listCameraInfo()`,
      // so a failure here is a still-settling handoff race (RT1), not an
      // absent camera.
      const lease = await retryUntil(() => acquire(serial));
      if (lease) await registerEntry(serial, lease);
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
      const found = await listCameraInfo();
      const present = new Set(found.map((c) => c.serial));
      const toOpen = found.map((c) => c.serial).filter((s) => !entries.has(s));
      if (toOpen.length > 0) {
        // One bulk discovery pass for every new camera (RT1 F3) instead of
        // one `Camera.list()` per serial; only fall back to a per-serial
        // retry for whichever ones a still-settling handoff race dropped.
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
              // Inputs send correctly-typed values (RangeSlider → number,
              // selects → string/boolean); assign straight through.
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
          // The registry stops the shared loop before `mutate` and restarts
          // it after (fresh reuse buffer for the new payload size); we retry
          // the set to absorb the cross-thread acquisition stop.
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
          try {
            c.frame_rate_enable = false;
            c.exposure_auto = "Once";
            c.gain_auto = "Once";
            if (c.black_level_auto_available) c.black_level_auto = "Once";
          } catch (err) {
            console.error("[manage-cameras] reset:", err);
          }
          e.role = undefined;
          await write(cameraConfigPath(c), {});
          publishViews();
        },
      },
      // No window viewing manage-cameras: stop the property poll and release
      // every opened camera. A later `refresh` (on remount) re-opens and
      // restarts polling.
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
