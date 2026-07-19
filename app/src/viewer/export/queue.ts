// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE viewer export QUEUE state machine (Electron/ffmpeg-free, unit-tested):
// owns job records + the serial/parallel dispatch policy, RETURNS the ids to
// start; the runner performs the ffmpeg spawn/abort.
// spec: docs/spec/viewer.md#export

import type { ExportRequest, ExportJobStatus, ExportState } from "./types.js";

interface JobRecord {
  id: number;
  request: ExportRequest;
  state: ExportState;
  progress: number | null;
  fps: number;
  etaSec: number | null;
  error?: string;
  /** The export EPISODE this job belongs to — a run of work that begins when a
   *  job enqueues into an otherwise-idle queue. Drives monotonic overall
   *  progress: terminal jobs of the current episode stay in the denominator so
   *  the headline % never dips as siblings finish. */
  episode: number;
}

function toStatus(j: JobRecord): ExportJobStatus {
  const stream = j.request.channel;
  const name = j.request.outputPath.split(/[/\\]/).pop() ?? stream;
  return {
    id: j.id,
    channel: stream,
    name,
    state: j.state,
    progress: j.progress,
    fps: j.fps,
    etaSec: j.etaSec,
    ...(j.error ? { error: j.error } : {}),
  };
}

export class ExportQueue {
  private jobsById = new Map<number, JobRecord>();
  private order: number[] = [];
  private nextId = 1;
  /** Current export episode (see JobRecord.episode). Bumped when a job enqueues
   *  into an idle queue, so a fresh run's progress restarts at 0 rather than
   *  inheriting last run's retained terminal jobs. */
  private episode = 0;

  constructor(private parallel = false) {}

  /** Enqueue a request; returns the job id AND the ids to START now (dispatch
   *  policy). The new job is `queued` until it appears in `start`. */
  enqueue(request: ExportRequest): { id: number; start: number[] } {
    const id = this.nextId++;
    // A job arriving into an idle queue opens a new episode (fresh overall %).
    if (this.activeCount() === 0) this.episode++;
    const job: JobRecord = {
      id, request, state: "queued", progress: null, fps: 0, etaSec: null, episode: this.episode,
    };
    this.jobsById.set(id, job);
    this.order.push(id);
    return { id, start: this.dispatch() };
  }

  /** Mark a running job finished (ok) or failed; returns the ids to START next
   *  (serial mode advances here). Unknown/terminal ids are a no-op. */
  complete(id: number, ok: boolean, error?: string): number[] {
    const job = this.jobsById.get(id);
    if (!job || job.state !== "running") return [];
    job.state = ok ? "done" : "failed";
    job.progress = ok ? 1 : job.progress;
    job.fps = 0;
    job.etaSec = null;
    if (!ok && error) job.error = error;
    return this.dispatch();
  }

  /** Abort a job. A RUNNING job → `aborted` (the caller SIGKILLs ffmpeg + unlinks
   *  the partial file); a QUEUED job → `aborted` without ever starting. Returns
   *  {aborted, wasRunning, start}: `wasRunning` tells the caller to kill the
   *  process; `start` is the newly-dispatched backlog (serial mode). */
  abort(id: number): { aborted: boolean; wasRunning: boolean; start: number[] } {
    const job = this.jobsById.get(id);
    if (!job || (job.state !== "queued" && job.state !== "running"))
      return { aborted: false, wasRunning: false, start: [] };
    const wasRunning = job.state === "running";
    job.state = "aborted";
    job.fps = 0;
    job.etaSec = null;
    return { aborted: true, wasRunning, start: this.dispatch() };
  }

  /** Abort every queued+running job (window close). Returns the ids of
   *  jobs that were RUNNING (the caller kills + unlinks each). */
  abortAll(): number[] {
    const running: number[] = [];
    for (const id of this.order) {
      const job = this.jobsById.get(id)!;
      if (job.state === "running") running.push(id);
      if (job.state === "queued" || job.state === "running") {
        job.state = "aborted";
        job.fps = 0;
        job.etaSec = null;
      }
    }
    return running;
  }

  /** Update live progress for a running job (from ffmpeg output parsing). No
   *  dispatch — a no-op for non-running ids. */
  progress(id: number, progress: number | null, fps: number, etaSec: number | null): void {
    const job = this.jobsById.get(id);
    if (!job || job.state !== "running") return;
    job.progress = progress;
    job.fps = fps;
    job.etaSec = etaSec;
  }

  /** Flip the parallel flag. Turning it ON dispatches the whole
   *  backlog; OFF never pauses a running job. Returns the ids to START. */
  setParallel(parallel: boolean): number[] {
    this.parallel = parallel;
    return this.dispatch();
  }

  isParallel(): boolean {
    return this.parallel;
  }

  /** The request for a job (the engine reads it when it actually launches). */
  request(id: number): ExportRequest | undefined {
    return this.jobsById.get(id)?.request;
  }

  /** Count of queued+running jobs (drives the close-intercept + tray badge). */
  activeCount(): number {
    let n = 0;
    for (const j of this.jobsById.values())
      if (j.state === "queued" || j.state === "running") n++;
    return n;
  }

  /** Snapshot for the renderer: terminal jobs are RETAINED (the tray shows
   *  done/failed until cleared — see `clearFinished`) in enqueue order. */
  snapshot(): ExportJobStatus[] {
    return this.order.map((id) => toStatus(this.jobsById.get(id)!));
  }

  /** Drop TERMINAL jobs (done/failed/aborted) from the snapshot — the tray's
   *  "Clear finished" affordance (results must not pin the tray icon for the
   *  window's lifetime with no exit). Running/queued jobs are untouched — and
   *  while the CURRENT episode is still active, its own terminal jobs are kept
   *  too: deleting them would pull 1.0-weight entries out of `overallProgress`'s
   *  denominator and drop the headline % (the exact non-monotonicity the episode
   *  model exists to prevent). They become clearable the moment the episode
   *  settles. */
  clearFinished(): void {
    const activeEpisode = this.activeCount() > 0 ? this.episode : -1;
    this.order = this.order.filter((id) => {
      const j = this.jobsById.get(id)!;
      if (j.state === "queued" || j.state === "running") return true;
      if (j.episode === activeEpisode) return true; // holds the denominator
      this.jobsById.delete(id);
      return false;
    });
  }

  /** Overall 0..1 progress across the CURRENT episode, or null when the episode
   *  is idle (no queued/running jobs — nothing was ever active, or the whole run
   *  finished). MONOTONIC across completions: terminal jobs stay in the
   *  denominator counting as fully done (1), so a finishing sibling can only
   *  raise the headline %, never drop it — dropping done jobs from the
   *  denominator would make the average jump around (e.g. 50→25→50). Queued
   *  jobs count as 0; running jobs count their live fraction. */
  overallProgress(): number | null {
    let sum = 0;
    let n = 0;
    let anyActive = false;
    for (const j of this.jobsById.values()) {
      if (j.episode !== this.episode) continue; // ignore retained prior-run jobs
      n++;
      if (j.state === "aborted") {
        // Cancelled ≠ work: an aborted job leaves BOTH numerator and
        // denominator (counting it as 1.0 inflated the headline — abort a
        // queued job and "progress" jumped).
        // Still monotonic: removing a 0-progress queued job from the
        // denominator can only raise the %.
        n--;
        continue;
      }
      if (j.state === "running") {
        sum += j.progress ?? 0;
        anyActive = true;
      } else if (j.state === "queued") {
        anyActive = true;
        // contributes 0
      } else {
        sum += 1; // done/failed — resolved, holds the denominator
      }
    }
    // Idle (all terminal, or empty) → null so the headline % clears.
    return n === 0 || !anyActive ? null : sum / n;
  }

  /** The dispatch decision: transition `queued` jobs to `running` per policy,
   *  returning the ids that JUST started so the caller launches exactly those.
   *  Serial ⇒ start one only when nothing runs; parallel ⇒ start all queued. */
  private dispatch(): number[] {
    const started: number[] = [];
    let runningCount = 0;
    for (const j of this.jobsById.values()) if (j.state === "running") runningCount++;
    for (const id of this.order) {
      const job = this.jobsById.get(id)!;
      if (job.state !== "queued") continue;
      if (!this.parallel && runningCount > 0) break;
      job.state = "running";
      runningCount++;
      started.push(id);
      if (!this.parallel) break;
    }
    return started;
  }
}
