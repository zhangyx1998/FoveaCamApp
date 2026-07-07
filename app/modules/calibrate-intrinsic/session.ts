// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-intrinsic session (docs/refactor/orchestrator.md §7.1 S1b): per-
// camera intrinsic calibration, moved off the renderer. Unlike the fixed-
// triple control-loop sessions, this one manages an arbitrary set of
// connected cameras (like manage-cameras) and leases only the one currently
// selected for live detection.
//
// Checkerboard detection runs on the registry's shared BGRA8 preview (via
// `onView`, converted to grayscale with `cvtColor` — the same "derive
// whatever the vision op needs from the one shared preview format" pattern
// tracking-single/disparity-scope already use, rather than opening a second
// pixel format). Marker detection can't do that: `MarkerDetector` only
// consumes a raw `Frame`/`Stream<Frame>`, not a `Mat`. Following the
// concurrent-raw-stream precedent manual-control's capture/recording already
// proved safe ("core's Sub::Queue gives each iterator its own bounded
// backlog"), marker detection runs its own independent
// `detector.stream(lease.camera.stream, ...)` consumer alongside the
// registry's own preview loop on the same camera.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { cameraConfigPath, listCameraInfo } from "@orchestrator/camera";
import { acquire, retryUntil, type CameraLease } from "@orchestrator/registry";
import { loadIntrinsic } from "@orchestrator/calibration";
import { read, write } from "@orchestrator/store-hub";
import { report } from "@orchestrator/diagnostics";
import { getCameraKey } from "@lib/camera-config";
import {
  CORNER_OBJ_POINTS,
  bilinearInterpolate,
  getInternalObjectPoints,
} from "@lib/marker";
import abortableNext from "@lib/abortable.next";
import {
  calibrateCamera,
  cornerSubPix,
  cvtColor,
  findChessboardCorners,
  MarkerDetector,
  type CameraCalibration,
  type Mat,
  type MarkerDetectResults,
  type PreDefinedDictionary,
} from "core/Vision";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { Point2d, Point3d } from "core/Geometry";
import { calibrateIntrinsic, type CalibrationView } from "./contract";

type Sample = { img_points: Point2d[]; obj_points: Point3d[] };
type Record_ = { gray: Mat<Uint8Array>; samples: Sample[] };

/** Checkerboard object points for the configured pattern size, unit spacing
 *  (matches the original renderer's `objPoints()` exactly). */
function checkerObjPoints(pattern: { width: number; height: number }): Point3d[] {
  const { width, height } = pattern;
  const dx = (width - 1) * 0.5;
  const dy = (height - 1) * 0.5;
  const out: Point3d[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) out.push({ x: x - dx, y: y - dy, z: 0 });
  return out;
}

export default function calibrateIntrinsicSession(): ServerSession<typeof calibrateIntrinsic> {
  return defineSession("calibrate-intrinsic", calibrateIntrinsic, (s) => {
    const known = new Map<string, CameraInfo>();
    // `ServerSession.telemetry()` is publish-only (no getter) — keep our own
    // mirror of the last-published views, same as `manage-cameras`' `entries`.
    let views: Record<string, CalibrationView> = {};

    let activeInfo: CameraInfo | null = null;
    let activeLease: CameraLease | null = null;
    let previewDisposer: (() => void) | null = null;
    let viewDisposer: (() => void) | null = null;
    let width = 0;
    let height = 0;
    let records: Record_[] = [];

    // CHECKER mode.
    let checkerBusy = false;
    let latestChecker: { gray: Mat<Uint8Array>; img_points: Point2d[] } | null = null;

    // MARKER mode.
    let markerDetector: MarkerDetector | null = null;
    let markerTask: ReturnType<typeof abortableNext> | null = null;
    let latestMarker: MarkerDetectResults | null = null;

    function clearRecords(): void {
      records = [];
      s.telemetry({ recordCount: 0 });
    }

    async function buildView(info: CameraInfo, role: string | undefined): Promise<CalibrationView> {
      const { undistort, date } = await loadIntrinsic(info);
      return {
        info,
        role,
        calibrated_at: date ? date.toISOString() : null,
        fov: undistort ? { x: undistort.fov.x, y: undistort.fov.y } : null,
      };
    }

    async function refresh(): Promise<void> {
      const found = await listCameraInfo();
      known.clear();
      const next: Record<string, CalibrationView> = {};
      for (const info of found) {
        known.set(info.serial, info);
        const { role } = await read<{ role?: string }>(cameraConfigPath(info), {});
        next[info.serial] = await buildView(info, role);
      }
      views = next;
      s.telemetry({ views });
    }

    // --- CHECKER mode ------------------------------------------------------

    function onCheckerView(raw: Mat<Uint8Array>): void {
      const [h, w] = raw.shape;
      if (w !== width || h !== height) {
        width = w;
        height = h;
        s.telemetry({ size: { width, height } });
        clearRecords();
      }
      if (checkerBusy) return;
      checkerBusy = true;
      const gray = cvtColor(raw, "BGRA2GRAY");
      void findChessboardCorners(gray, s.state.pattern_size)
        .then((corners) => {
          if (corners.length > 0) {
            latestChecker = { gray, img_points: corners };
            s.telemetry({ detection: { points: corners } });
          } else {
            latestChecker = null;
            s.telemetry({ detection: null });
          }
        })
        .finally(() => {
          checkerBusy = false;
        });
    }

    // --- MARKER mode ---------------------------------------------------

    function stopMarkerTask(): void {
      markerTask?.abort();
      markerTask = null;
      markerDetector = null;
      // The held detection's Frame is never released by the loop below once
      // the loop itself stops running — release it here instead of leaking
      // the native buffer.
      latestMarker?.frame.release();
      latestMarker = null;
    }

    function startMarkerTask(lease: CameraLease): void {
      const detector = new MarkerDetector(s.state.dictionary as PreDefinedDictionary);
      markerDetector = detector;
      const stream = detector.stream(lease.camera.stream, 1 / Math.max(1, s.state.scale));
      markerTask = abortableNext(async (ctx) => {
        for (const result of ctx.iter(stream)) {
          if (!result) {
            await new Promise((r) => setTimeout(r, 1));
            continue;
          }
          if (result.frame.width !== width || result.frame.height !== height) {
            width = result.frame.width;
            height = result.frame.height;
            s.telemetry({ size: { width, height } });
            clearRecords();
          }
          // The previous detection's frame is no longer "current" — release
          // it now (mirrors the original's `watch(detection, (_,prev) =>
          // prev?.frame.release())`). `capture()` retains the *current* one
          // via `.ref()` before it would otherwise be released here.
          if (latestMarker && latestMarker !== result) latestMarker.frame.release();
          latestMarker = result;
          const points = result.flatMap((r: Point2d[]) => [...r]);
          s.telemetry({ detection: points.length > 0 ? { points } : null });
        }
      });
      // `ctx.iter(stream)`'s wrapped iterator throws `AbortedError` from its
      // *next* `next()` call once `.abort()` is triggered — that's the
      // cooperative-cancellation contract, not a real failure, so it's
      // expected to reject this task's promise on every stop. Nothing else
      // observes `markerTask` (it's a fire-and-forget background loop, same
      // as every other session's activation loop) — swallow the expected
      // case, report anything else the same way the registry's own preview
      // loop would.
      markerTask.catch((e) => {
        if (e instanceof abortableNext.AbortedError) return;
        report("calibrate-intrinsic", e instanceof Error ? e.message : String(e));
      });
    }

    // --- lifecycle for the active camera ------------------------------

    function restartDetection(): void {
      if (!activeLease) return;
      viewDisposer?.();
      viewDisposer = null;
      stopMarkerTask();
      clearRecords();
      s.telemetry({ detection: null });
      if (s.state.method === "CHECKER") {
        viewDisposer = activeLease.onView(onCheckerView);
      } else {
        startMarkerTask(activeLease);
      }
    }

    async function select({ serial }: { serial: string }): Promise<void> {
      await deselect();
      const lease = await retryUntil(() => acquire(serial));
      if (!lease) return;
      activeLease = lease;
      activeInfo = known.get(serial) ?? null;
      previewDisposer = lease.onFrame((payload) => s.frame("preview", payload));
      s.setState("activeSerial", serial);
      restartDetection();
    }

    async function deselect(): Promise<void> {
      previewDisposer?.();
      previewDisposer = null;
      viewDisposer?.();
      viewDisposer = null;
      stopMarkerTask();
      latestChecker = null;
      clearRecords();
      activeLease?.release();
      activeLease = null;
      activeInfo = null;
      width = height = 0;
      s.setState("activeSerial", null);
      s.telemetry({ detection: null, size: { width: 0, height: 0 } });
    }

    async function capture(): Promise<void> {
      if (s.state.method === "CHECKER") {
        const d = latestChecker;
        if (!d) return;
        latestChecker = null;
        records.push({
          gray: d.gray,
          samples: [{ img_points: d.img_points, obj_points: checkerObjPoints(s.state.pattern_size) }],
        });
      } else {
        const d = latestMarker;
        const detector = markerDetector;
        if (!d || !detector) return;
        // Nulling `latestMarker` here means the detection loop's own
        // "supersede the previous one" check (which normally releases its
        // implicit per-yield ref once a newer result arrives) will never see
        // this result again — its cleanup responsibility transfers to us:
        // `.ref()` for our own temporary hold across the awaited `view()`
        // call, then release *both* that temporary hold and the loop's
        // implicit ref once we're done extracting data from it.
        latestMarker = null;
        s.telemetry({ detection: null });
        const frame = d.frame.ref();
        const gray = await frame.view("Mono8");
        frame.release(); // our temporary hold
        d.frame.release(); // the loop's implicit per-yield ref
        const samples: Sample[] = [];
        for (const r of d) {
          const internal = Array.from(getInternalObjectPoints(detector.pattern(r.id)));
          const obj_points = [...CORNER_OBJ_POINTS, ...internal];
          const img_points = [...(r as unknown as Point2d[]), ...bilinearInterpolate(r, internal)];
          samples.push({ img_points, obj_points });
        }
        records.push({ gray, samples });
      }
      s.telemetry({ recordCount: records.length });
    }

    function removeRecord({ index }: { index: number }): void {
      records.splice(index, 1);
      s.telemetry({ recordCount: records.length });
    }

    async function calibrateNow(): Promise<void> {
      if (!activeInfo || records.length === 0) return;
      s.telemetry({ busy: true });
      try {
        const flat = records.flatMap((r) => r.samples.map((sm) => ({ ...sm, gray: r.gray })));
        const img_points = await Promise.all(flat.map((sm) => cornerSubPix(sm.gray, sm.img_points)));
        const obj_points = flat.map((sm) => sm.obj_points);
        const result: CameraCalibration = await calibrateCamera(
          { width, height },
          img_points,
          obj_points,
        );
        const key = getCameraKey(activeInfo);
        await write(["calibrate-intrinsic", key], { ...result, date: new Date() });
        const view = await buildView(activeInfo, views[activeInfo.serial]?.role);
        views = { ...views, [activeInfo.serial]: view };
        s.telemetry({ views });
      } finally {
        s.telemetry({ busy: false });
      }
    }

    async function resetCalibration({ serial }: { serial: string }): Promise<void> {
      const info = known.get(serial);
      if (!info) return;
      await write(["calibrate-intrinsic", getCameraKey(info)], {});
      const view = await buildView(info, views[serial]?.role);
      views = { ...views, [serial]: view };
      s.telemetry({ views });
    }

    return {
      commands: {
        refresh,
        select,
        deselect,
        capture,
        removeRecord,
        calibrateNow,
        resetCalibration,
      },
      watch: {
        method: restartDetection,
        pattern_size: restartDetection,
        dictionary: restartDetection,
        scale: restartDetection,
      },
      idle() {
        void deselect();
      },
    };
  });
}
