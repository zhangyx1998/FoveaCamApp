// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-intrinsic session (docs/history/refactor/orchestrator.md §7.1 S1b): per-
// camera intrinsic calibration, moved off the renderer. Unlike the fixed-
// triple control-loop sessions, this one manages an arbitrary set of
// connected cameras (like manage-cameras) and leases only the one currently
// selected for live detection.
//
// Checkerboard detection runs on the registry's shared BGRA8 preview (via
// `onView`, converted to grayscale with `cvtColor` — the same "derive
// whatever the vision op needs from the one shared preview format" pattern
// disparity-scope already uses, rather than opening a second
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
  MarkerDetector,
  resize,
  type CameraCalibration,
  type Mat,
  type MarkerDetectResults,
  type PreDefinedDictionary,
} from "core/Vision";
import { createVisionWorker, type VisionWorkerHandle } from "@orchestrator/vision-worker-host";
import { nodeId } from "@lib/orchestrator/graph-contract";
import type { PipeBroker } from "@orchestrator/pipe-session";
import type { PipeInput, VisionResult } from "@orchestrator/vision-worker-protocol";
import type { CheckerValues } from "./vision";
import { makeMat } from "@lib/mat";
import type { CameraInfo } from "@lib/orchestrator/contracts";
import type { Point2d, Point3d } from "core/Geometry";
import { calibrateIntrinsic, type CalibrationView, type RecordThumb } from "./contract";

type Sample = { img_points: Point2d[]; obj_points: Point3d[] };
type Record_ = { gray: Mat<Uint8Array>; samples: Sample[]; thumb: RecordThumb };

/** Longest edge (px) of a record preview thumbnail (proposal item 4 — keep the
 *  telemetry payload small). */
const THUMB_WIDTH = 160;

/** Downscale a captured grayscale Mat to a small Mono8 preview for the records
 *  list. `id` is the record's stable key. */
async function makeThumb(gray: Mat<Uint8Array>, id: number): Promise<RecordThumb> {
  const gw = gray.shape[1] ?? 1;
  const gh = gray.shape[0] ?? 1;
  const width = Math.min(THUMB_WIDTH, gw);
  const height = Math.max(1, Math.round((gh * width) / gw));
  const small = await resize(gray, { width, height });
  // Copy out of the (possibly reused) native buffer before it can be recycled.
  const data = new Uint8Array(
    small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength),
  );
  return { id, width: small.shape[1] ?? width, height: small.shape[0] ?? height, data };
}

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

export default function calibrateIntrinsicSession(broker: PipeBroker): ServerSession<typeof calibrateIntrinsic> {
  return defineSession("calibrate-intrinsic", calibrateIntrinsic, (s) => {
    const known = new Map<string, CameraInfo>();
    // `ServerSession.telemetry()` is publish-only (no getter) — keep our own
    // mirror of the last-published views, same as `manage-cameras`' `entries`.
    let views: Record<string, CalibrationView> = {};

    let activeInfo: CameraInfo | null = null;
    let activeLease: CameraLease | null = null;
    let previewDisposer: (() => void) | null = null;
    let width = 0;
    let height = 0;
    let records: Record_[] = [];
    // Stable per-capture id (item 4) — survives sibling removal reindexing.
    let recordSeq = 0;

    // Detector throughput (item 6): every detection tick bumps `detectCount`;
    // a ~1 Hz timer converts the delta to Hz for the StreamView footnote.
    let detectCount = 0;
    let rateTimer: ReturnType<typeof setInterval> | null = null;
    let rateAnchor = 0;

    function publishRecords(): void {
      s.telemetry({
        recordCount: records.length,
        records: records.map((r) => r.thumb),
      });
    }

    // CHECKER mode — detection runs in the `checker` vision worker (C-22b step 3,
    // off the JS event loop). It posts the corner points + the gray frame; main
    // retains the gray for `cornerSubPix`/`calibrateCamera` at capture time.
    let checkerWorker: VisionWorkerHandle | null = null;
    let checkerPipeId: string | null = null;
    let latestChecker: { gray: Mat<Uint8Array>; img_points: Point2d[] } | null = null;

    // MARKER mode.
    let markerDetector: MarkerDetector | null = null;
    let markerTask: ReturnType<typeof abortableNext> | null = null;
    let latestMarker: MarkerDetectResults | null = null;

    function clearRecords(): void {
      records = [];
      publishRecords();
    }

    async function buildView(info: CameraInfo, role: string | undefined): Promise<CalibrationView> {
      const { undistort, date, rms } = await loadIntrinsic(info);
      return {
        info,
        role,
        calibrated_at: date ? date.toISOString() : null,
        fov: undistort ? { x: undistort.fov.x, y: undistort.fov.y } : null,
        rms,
      };
    }

    function startRateTimer(): void {
      detectCount = 0;
      rateAnchor = performance.now();
      rateTimer ??= setInterval(() => {
        const now = performance.now();
        const dt = (now - rateAnchor) / 1000;
        s.telemetry({ detectRate: dt > 0 ? detectCount / dt : 0 });
        detectCount = 0;
        rateAnchor = now;
      }, 1000);
    }

    function stopRateTimer(): void {
      if (rateTimer) clearInterval(rateTimer);
      rateTimer = null;
      detectCount = 0;
      s.telemetry({ detectRate: 0 });
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

    // --- CHECKER mode (vision worker) -------------------------------------

    function stopCheckerWorker(): void {
      checkerWorker?.terminate();
      checkerWorker = null;
      if (checkerPipeId) {
        broker.disconnect(checkerPipeId);
        checkerPipeId = null;
      }
    }

    function startCheckerWorker(lease: CameraLease): void {
      const pipeId = nodeId.convert(lease.camera.serial);
      const handle = broker.connect(pipeId);
      checkerPipeId = pipeId;
      const { width: w, height: h, channels, bytesPerFrame, maxBytes } = handle.spec;
      const pipe: PipeInput = {
        role: "C",
        shmName: handle.shmName,
        width: w,
        height: h,
        channels,
        bytesPerFrame: maxBytes ?? bytesPerFrame,
      };
      checkerWorker = createVisionWorker(
        {
          pipes: [pipe],
          params: {
            kind: "checker",
            patternWidth: s.state.pattern_size.width,
            patternHeight: s.state.pattern_size.height,
          },
          // meterName: kernel visible in perfSnapshot.workloads (self-meter).
          meterName: nodeId.win("calibrate-intrinsic", "checker"),
        },
        onCheckerResult,
      );
    }

    function onCheckerResult(r: VisionResult): void {
      detectCount++; // item 6: one processed frame (matched or not)
      const v = r.values as CheckerValues;
      if (v.size) {
        width = v.size.width;
        height = v.size.height;
        s.telemetry({ size: { width, height } });
        clearRecords();
      }
      if (v.points && v.points.length > 0) {
        const grayFrame = r.frames.find((f) => f.name === "gray");
        if (grayFrame) {
          latestChecker = {
            gray: makeMat(new Uint8Array(grayFrame.buffer), [grayFrame.height, grayFrame.width], grayFrame.channels),
            img_points: v.points,
          };
          s.telemetry({ detection: { points: v.points } });
        }
      } else if (v.points === null) {
        latestChecker = null;
        s.telemetry({ detection: null });
      }
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
          detectCount++; // item 6: one processed frame
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
      stopCheckerWorker();
      stopMarkerTask();
      clearRecords();
      s.telemetry({ detection: null });
      if (s.state.method === "CHECKER") {
        startCheckerWorker(activeLease);
      } else {
        startMarkerTask(activeLease);
      }
    }

    async function select({ serial }: { serial: string }): Promise<void> {
      await deselect();
      // Spin-up progress (ruling 2026-07-09): this session has no `activate`
      // hook — a camera is leased per `select`, so the monitor is declared here
      // (after the previous camera's teardown). A failed lease leaves the list
      // FROZEN at "Leasing camera"; the next `select` supersedes it and window-
      // close idle (runIdle) clears it. `complete` fires once detection is live.
      const monitor = s.progressMonitor([
        { id: "lease", label: "Leasing camera" },
        { id: "detection", label: "Starting detection" },
      ]);
      monitor.start("lease");
      const lease = await retryUntil(() => acquire(serial));
      if (!lease) return; // frozen at "Leasing camera"
      monitor.done("lease");
      activeLease = lease;
      activeInfo = known.get(serial) ?? null;
      // real-1c: the raw preview now rides the `camera:<serial>` native pipe;
      // the renderer reads it via `usePipeFrame`, not `s.frame("preview")`.
      // (The marker-detection view-tap below stays on the JS loop.)
      s.setState("activeSerial", serial);
      monitor.start("detection");
      restartDetection();
      startRateTimer();
      monitor.done("detection");
      monitor.complete(); // spin-up finished — clear the overlay
    }

    async function deselect(): Promise<void> {
      previewDisposer?.();
      previewDisposer = null;
      stopRateTimer();
      stopCheckerWorker();
      stopMarkerTask();
      latestChecker = null;
      clearRecords();
      activeLease?.release();
      activeLease = null;
      activeInfo = null;
      width = height = 0;
      s.setState("activeSerial", null);
      s.telemetry({ detection: null, size: { width: 0, height: 0 }, lastRms: null });
    }

    /** Commit one captured (gray, samples) pair as a record + its preview
     *  thumbnail (item 4), then republish the records list. */
    async function pushRecord(gray: Mat<Uint8Array>, samples: Sample[]): Promise<void> {
      const thumb = await makeThumb(gray, recordSeq++);
      records.push({ gray, samples, thumb });
      publishRecords();
    }

    async function capture(): Promise<void> {
      if (s.state.method === "CHECKER") {
        const d = latestChecker;
        if (!d) return;
        latestChecker = null;
        await pushRecord(d.gray, [
          { img_points: d.img_points, obj_points: checkerObjPoints(s.state.pattern_size) },
        ]);
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
        await pushRecord(gray, samples);
      }
    }

    function removeRecord({ index }: { index: number }): void {
      records.splice(index, 1);
      publishRecords();
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
        // item 5: report the solve's RMS re-projection error post-solve.
        s.telemetry({ views, lastRms: typeof result.rms === "number" ? result.rms : null });
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
