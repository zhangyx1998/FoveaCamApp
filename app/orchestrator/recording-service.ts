// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Composable recording facility: the ~90%-shared skeleton the per-app recording
// controllers ran (start/stop around the recorder node, a 250ms stats poll, the
// recording_active/recordingStreams telemetry incl. the F2 drop split, and the
// acquire-then-build unwind discipline). Each app passes config; the app's `acquire`
// decides which pipes to record and returns a reverse-order `release` closure. The
// facility owns one throw path: build-after-acquire failure releases and rethrows.
// spec: docs/spec/capture-recording.md#recording-service

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createRecorderNode,
  type RecorderNodeHandle,
  type RecorderNodeOptions,
  type RecorderStreamStats,
} from "@orchestrator/recorder-node";
import { report } from "./diagnostics.js";

/** The telemetry patch a recording session publishes (the exact shape both
 *  existing controllers already emit — F2 drop split rides `RecorderStreamStats`
 *  transparently). */
export type RecordingTelemetryPatch = {
  recording_active?: boolean;
  recordingStreams?: Record<string, RecorderStreamStats>;
};

/** The result of one `acquire`: the recorder-node options the app assembled
 *  (everything except id/path/timestamp, which the facility injects) plus the
 *  unwind closure for every resource acquired to build them. */
export interface RecordingAcquisition {
  /** Recorder-node options MINUS `id`/`path`/`timestamp` (the facility supplies
   *  those). Carries the app's `streams`, `connect`, and any `onFrame`,
   *  `extrasStreams`, `cameraMatrix`, etc. */
  nodeOptions: Omit<RecorderNodeOptions, "id" | "path" | "timestamp">;
  /** Unwind ALL resources acquired to build `nodeOptions` — retire bricks then
   *  release raw pipes in REVERSE (last release retires + unadvertises). Called
   *  by the facility BOTH on a recorder-node build throw and on `stop()`. */
  release(): void;
}

export interface RecordingServiceConfig {
  /** Graph node id — `recorder/<session>`. */
  id: string;
  /** Refuse guard: true iff the session holds the resources a recording needs
   *  (calibrated triple / leased cameras). Checked BEFORE mkdir + acquire, so a
   *  refusal leaves no stray directory and no advertised pipe. */
  ready(): boolean;
  /** Optional async setup run AFTER `ready()` passes and BEFORE mkdir + acquire
   *  — the seam for a "read the config at RECORDING START" step (the app-level
   *  compression method: `@orchestrator/record-compression`). Its result is
   *  stashed by the config for `acquire` to read synchronously. Runs before the
   *  directory exists, so a throw aborts the start leaving no stray dir/advert. */
  prepare?(): Promise<void>;
  /** Acquire the recordable resources + assemble the node options. Runs only
   *  after `ready()` passed and the container's parent directory exists. MAY throw for an internal
   *  acquire fault — it must unwind its OWN partial state then (the facility's
   *  unwind covers only the recorder-node-build throw, via the returned
   *  `release`). */
  acquire(path: string): RecordingAcquisition;
  /** Publish a telemetry patch (session `s.telemetry`). */
  telemetry(patch: RecordingTelemetryPatch): void;
  /** Notify main a recording finished so the viewer window auto-opens it. */
  finished(foveaPath: string): void;
  /** Test seam: the recorder node factory (default: the real one). */
  createNode?: (options: RecorderNodeOptions) => RecorderNodeHandle;
  /** After the node is live + `active` set (e.g. multi-fovea channel sync for
   *  targets already armed at start). */
  onStarted?(node: RecorderNodeHandle): void;
  /** After `node.stop()` + release, before the idle telemetry (e.g. multi-fovea
   *  dts-map clear). */
  onStopped?(): void;
  /** Stats poll interval (ms, default 250). */
  pollMs?: number;
}

export interface RecordingService {
  /** True while a recording is running (drain-refusal probe — the multi-window
   *  switch path must not force-drain mid-recording). */
  readonly active: boolean;
  /** The live recorder node while active (for churn: addDataStream/postData),
   *  else null. */
  readonly node: RecorderNodeHandle | null;
  start(path: string): Promise<boolean>;
  stop(): Promise<boolean>;
}

export function createRecordingService(config: RecordingServiceConfig): RecordingService {
  let active = false;
  let node: RecorderNodeHandle | null = null;
  let acquisition: RecordingAcquisition | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const pollMs = config.pollMs ?? 250;
  const createNode = config.createNode ?? createRecorderNode;

  function publishStreams(): void {
    config.telemetry({ recordingStreams: node?.stats() ?? {} });
  }

  return {
    get active() {
      return active;
    },
    get node() {
      return node;
    },

    async start(path: string): Promise<boolean> {
      if (active) return false;
      path = path.trim();
      if (path === "") return false;
      // Guard BEFORE mkdir/acquire (refusal leaves no stray dir/advert).
      if (!config.ready()) return false;
      // Read-at-start seam (compression method): before mkdir, so a config-read
      // throw aborts with no stray dir/advert.
      await config.prepare?.();
      // `path` is the CONTAINER path (`<dir>/<seq>` → `<dir>/<seq>.fcap`, one
      // file per recording — no per-recording directory); ensure its parent.
      mkdirSync(dirname(path), { recursive: true });

      const acq = config.acquire(path);
      // Error-path guard (20e8834): the acquire refcounted the raw producers;
      // the native recorder-node build can still throw (worker spawn / broker
      // connect). A throw before `active = true` would orphan acquired handles
      // with the controller idle — the deferred cleanup never fires, and a retry
      // double-refcounts (never unadvertises → camera-exclusivity hazard).
      // Release symmetrically (reverse order, last release retires) + rethrow.
      try {
        node = createNode({
          id: config.id,
          path,
          timestamp: new Date().toISOString(),
          ...acq.nodeOptions,
        });
      } catch (err) {
        acq.release();
        node = null;
        throw err;
      }

      acquisition = acq;
      active = true;
      config.telemetry({ recording_active: true, recordingStreams: {} });
      pollTimer = setInterval(publishStreams, pollMs);
      config.onStarted?.(node);
      return true;
    },

    async stop(): Promise<boolean> {
      if (!active) return false;
      active = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      const finished = node;
      // Finalize the container (drains to the producers' latest, writes the mcap
      // summary/index, terminates the worker, disconnects the pipes) BEFORE
      // retiring producers.
      const stats = await node?.stop();
      node = null;
      // Release the acquisition AFTER the node released its connections (retire
      // bricks then release raw pipes — last release retires + unadvertises).
      acquisition?.release();
      acquisition = null;
      config.onStopped?.();
      config.telemetry({ recording_active: false, recordingStreams: {} });
      // value-sweep-2026-07-11 (`recording-finalize-truncation-reads-as-success`):
      // a wedged/failed finalize left a crash-shape container on disk. Surface it
      // through the process-wide error path (→ renderer error tray) and DO NOT
      // auto-open the viewer on a truncated file — the operator learned about it
      // at playback before, after the rig was torn down. A clean finalize
      // auto-opens the viewer exactly as before.
      if (finished && stats?.truncated) {
        report(
          config.id,
          `recording finalize did not complete — "${finished.filePath}" is truncated ` +
            `(not auto-opened; the container may be incomplete)`,
        );
      } else if (finished) {
        config.finished(finished.filePath);
      }
      return true;
    },
  };
}
