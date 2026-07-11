// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// calibrate-intrinsic session — per-camera intrinsic calibration, leasing only
// the currently-selected camera for live checker/marker detection. Behavior
// spec: docs/spec/calibrate-intrinsic.md.

import { defineSession, type ServerSession } from "@orchestrator/runtime";
import { cameraConfigPath, listCameraInfo } from "@orchestrator/camera";
import { acquire, retryUntil, type CameraLease } from "@orchestrator/registry";
import { loadIntrinsic } from "@orchestrator/calibration";
import { read, write, clear, list } from "@orchestrator/store-hub";
import {
  INTRINSIC_STORE,
  addAssociation,
  intrinsicInner,
  isRecordId,
  makeRecord,
  recordId,
  removeAssociations,
  type CalibrationRecord,
} from "@lib/calibration-records";
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
import { createRawRecording } from "@orchestrator/raw-recording";
import {
  createCaptureHelper,
  rawSingleShot,
  type CaptureHelper,
} from "@orchestrator/capture-helper";
import type { RawPipeRegistry } from "@orchestrator/raw-pipe";
import type { CompressPipeSeam } from "@orchestrator/compress-pipe";
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

export default function calibrateIntrinsicSession(
  broker: PipeBroker,
  rawPipes: RawPipeRegistry,
  compress?: CompressPipeSeam,
): ServerSession<typeof calibrateIntrinsic> {
  return defineSession("calibrate-intrinsic", calibrateIntrinsic, (s) => {
    const known = new Map<string, CameraInfo>();
    // `ServerSession.telemetry()` is publish-only (no getter) — keep our own
    // mirror of the last-published views, same as `manage-cameras`' `entries`.
    let views: Record<string, CalibrationView> = {};

    let activeInfo: CameraInfo | null = null;
    let activeLease: CameraLease | null = null;
    let previewDisposer: (() => void) | null = null;

    // Recording — the degenerate single-stream case (spec §capture).
    const recording = createRawRecording({
      id: "recorder/calibrate-intrinsic",
      broker,
      rawPipes,
      compress,
      streams: () => (activeLease ? { camera: activeLease.camera } : null),
      finished: (foveaPath) =>
        process.parentPort?.postMessage({ type: "recording:finished", path: foveaPath }),
      telemetry: (patch) => s.telemetry(patch),
    });

    // Capture — the degenerate single-stream case, built per `select`, reusing
    // the select lease (spec §capture).
    let captureHelper: CaptureHelper | null = null;
    let width = 0;
    let height = 0;
    let records: Record_[] = [];
    // Stable per-capture id (item 4) — survives sibling removal reindexing.
    let recordSeq = 0;

    // Detector throughput: a ~1 Hz timer converts the tick delta to Hz.
    let detectCount = 0;
    let rateTimer: ReturnType<typeof setInterval> | null = null;
    let rateAnchor = 0;

    function publishRecords(): void {
      s.telemetry({
        recordCount: records.length,
        records: records.map((r) => r.thumb),
      });
    }

    // CHECKER mode — detection in the `checker` vision worker (spec §detection);
    // main retains the posted gray for capture-time solve.
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
          meterName: nodeId.win("calibrate-intrinsic", "checker"), // kernel self-meter

        },
        onCheckerResult,
      );
    }

    function onCheckerResult(r: VisionResult): void {
      detectCount++; // one processed frame (matched or not)
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
      // Release the held frame here — the stopped loop never will (spec §frame-lifetime).
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
          // Release the previous (no-longer-current) detection's frame; capture()
          // retains the current one via `.ref()` first (spec §frame-lifetime).
          if (latestMarker && latestMarker !== result) latestMarker.frame.release();
          latestMarker = result;
          detectCount++; // one processed frame
          const points = result.flatMap((r: Point2d[]) => [...r]);
          s.telemetry({ detection: points.length > 0 ? { points } : null });
        }
      });
      // AbortedError on every stop is the cooperative-cancellation contract, not
      // a failure (spec §detection) — swallow it, report anything else.
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
      // No `activate` hook — a camera is leased per `select`, so the monitor is
      // declared here. A failed lease leaves the list FROZEN at "Leasing camera".
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
      // Raw preview rides the `camera:<serial>` native pipe (renderer usePipeFrame).
      s.setState("activeSerial", serial);
      monitor.start("detection");
      restartDetection();
      startRateTimer();
      // Single-stream capture over this camera's raw sensor pipe (spec §capture).
      captureHelper = createCaptureHelper({
        id: nodeId.win("calibrate-intrinsic", "capture"),
        broker,
        rawPipes,
        graphInputs: { single: `camera/${serial}/raw` },
        camera: () => activeLease?.camera ?? null,
        snapshot: (reset, indexed) =>
          activeLease
            ? rawSingleShot({
                reset,
                indexed,
                stackCount: 5,
                resource: "sensor",
                note: "calibrate-intrinsic: raw sensor stack (single camera)",
              })
            : null,
        recordingActive: () => recording.active,
        telemetry: (patch) => s.telemetry(patch),
      });
      captureHelper.build();
      monitor.done("detection");
      monitor.complete(); // spin-up finished — clear the overlay
    }

    async function deselect(): Promise<void> {
      // Finalize an in-flight recording before the lease releases (the recorder
      // drains + releases its raw pipe while the camera is still leased).
      await recording.stop();
      // Finalize + tear down capture before the lease releases (await any
      // in-flight shot so its on-demand raw pipe releases while still leased).
      if (captureHelper) {
        await captureHelper.activeCapture;
        await captureHelper.stop();
        captureHelper = null;
        s.telemetry({ capture_meta: {} });
      }
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
        // Capture owns cleanup now (spec §frame-lifetime): ref for our hold
        // across the awaited view(), then release both it + the loop's ref.
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
        // Persist as an intrinsic RECORD, idempotent by content-hash id (spec §records).
        const inner = intrinsicInner({ ...result });
        const id = await recordId(inner);
        const existing = await read<CalibrationRecord | null>([INTRINSIC_STORE, id], null);
        const assoc = { cameraKey: key, role: views[activeInfo.serial]?.role };
        const record =
          existing && existing.inner
            ? addAssociation(existing, assoc)
            : await makeRecord(inner, {
                created: new Date().toISOString(),
                associations: [assoc],
              });
        await write([INTRINSIC_STORE, id], record);
        const view = await buildView(activeInfo, views[activeInfo.serial]?.role);
        views = { ...views, [activeInfo.serial]: view };
        s.telemetry({ views, lastRms: typeof result.rms === "number" ? result.rms : null });
      } finally {
        s.telemetry({ busy: false });
      }
    }

    async function resetCalibration({ serial }: { serial: string }): Promise<void> {
      const info = known.get(serial);
      if (!info) return;
      const cameraKey = getCameraKey(info);
      // Drop THIS camera's association from every intrinsic record; an orphaned
      // record is hard-cleared (spec §records).
      const names = (await list(INTRINSIC_STORE)).filter(isRecordId);
      for (const id of names) {
        const rec = await read<CalibrationRecord | null>([INTRINSIC_STORE, id], null);
        if (!rec || rec.inner?.kind !== "intrinsic") continue;
        if (!rec.outer.associations.some((a) => a.cameraKey === cameraKey)) continue;
        const { record, orphaned } = removeAssociations(rec, (a) => a.cameraKey === cameraKey);
        if (orphaned) await clear([INTRINSIC_STORE, id]);
        else await write([INTRINSIC_STORE, id], record);
      }
      // Also clear any un-migrated legacy per-camera doc (read-only fallback).
      await clear(["calibrate-intrinsic", cameraKey]);
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
        async startRecording({ path }) {
          if (captureHelper?.capturing) return false; // exclusivity (spec §capture)
          return recording.start(path);
        },
        async stopRecording() {
          await recording.stop();
        },
        // Forward to the shared single-stream capture helper (distinct from the
        // `capture` calibration-record command above).
        async captureShot({ tag }) {
          if (!captureHelper) throw new Error("Capture not ready");
          await captureHelper.captureShot(tag);
        },
        async getCapturePreview({ resource, index }) {
          return captureHelper ? captureHelper.getPreview(resource, index) : null;
        },
        async saveCapture({ path, format }) {
          await captureHelper?.save(path, format);
        },
        async discardCapture() {
          await captureHelper?.discard();
        },
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
      busy() {
        if (captureHelper?.capturing) return "capture in progress";
        if (recording.active) return "recording in progress";
        return null;
      },
    };
  });
}
