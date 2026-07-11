// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared Node-free value types for the viewer export, crossing the dialog,
// protocol, and runner surfaces.
// spec: docs/spec/viewer.md#export

import type { CodecId } from "./codecs.js";

/** FPS-normalization mode (spec 7). `as-is` feeds decoded frames sequentially at
 *  the target fps (assumes aligned equal-interval frames — the DEFAULT).
 *  `resample` seeks onto a uniform timebase and BLENDS adjacent frames by
 *  temporal distance (pure TS, codec-agnostic). */
export type NormalizeMode = "as-is" | "resample";

/** A fully-resolved export request the renderer hands the engine (spec 2–8).
 *  Every field is already validated against the codec table by the dialog. */
export interface ExportRequest {
  /** Frame channel topic to export. */
  channel: string;
  codec: CodecId;
  /** ffmpeg `-pix_fmt` (output). */
  pixfmt: string;
  /** ProRes profile id (`prores` only). */
  profile?: string;
  /** Output frame rate. */
  fps: number;
  normalize: NormalizeMode;
  /** Apply undistort remap (only when the stream carries calibration — spec 4). */
  undistort: boolean;
  /** Emit an alpha plane; OOB remap regions become transparent (spec 5). Only
   *  meaningful when the pixfmt supports alpha AND undistort is on. */
  alpha: boolean;
  /** Absolute output path chosen via the system save dialog (spec 8). */
  outputPath: string;
}

/** Lifecycle state of one queued/running export (spec 9/10). */
export type ExportState = "queued" | "running" | "done" | "failed" | "aborted";

/** Per-export status snapshot the engine pushes to the renderer for the
 *  title-bar progress tray (spec 9). */
export interface ExportJobStatus {
  id: number;
  channel: string;
  /** Output basename for the hover report. */
  name: string;
  state: ExportState;
  /** 0..1 completion (frames written / total), or null when total is unknown. */
  progress: number | null;
  /** Instantaneous encode rate (frames/sec), 0 until measurable. */
  fps: number;
  /** Estimated seconds remaining, or null when not computable. */
  etaSec: number | null;
  /** Failure message (`failed` only). */
  error?: string;
}

/** Aggregate export status for the tray: overall progress + the per-job list
 *  (spec 9). `overall` is null when nothing is running. */
export interface ExportOverview {
  jobs: ExportJobStatus[];
  /** Count of queued+running jobs (drives the badge + close-intercept). */
  active: number;
  /** 0..1 overall progress across active jobs, or null when idle. */
  overall: number | null;
}
