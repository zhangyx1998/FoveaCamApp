// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The viewer export RUNNER (viewer-export.md pipeline) — hosted by the viewer
// ENGINE utilityProcess (worker.ts), the ONE process that already random-
// accesses `.fcap` frames + owns the core-backed decoders (the no-core exception
// is the engine, never the renderer). It drives the pure `ExportQueue`'s
// dispatch decisions with real ffmpeg child processes: decode → normalize to raw
// `rgba` → pipe into the resolved ffmpeg binary (optionally through a remap
// filter for undistort) → parse progress from the frames it feeds → SIGKILL +
// unlink on abort.
//
// The queue / codec-table / arg-builder / fps / undistort / normalize logic is
// all pure + unit-tested; THIS module is the impure edge (child_process, fs) and
// is exercised by the ffmpeg smoke test.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Mat } from "core/Vision";
import type { FoveaChannel, FoveaSource } from "../source.js";
import type { FrameDecoder } from "../decode.js";
import { parseDecodeProps } from "../decode.js";
import { ExportQueue } from "./queue.js";
import { buildFfmpegArgs } from "./ffmpeg-args.js";
import { buildRemapMaps, remapMapsToPgm, type Calibration } from "./undistort.js";
import { toRGBA } from "./normalize.js";
import { uniformTimeline, blendWeights, blendFrames } from "./fps.js";
import type { ExportRequest, ExportOverview } from "./types.js";

export interface ExportRunnerDeps {
  source: FoveaSource;
  /** Build (or reuse) a per-channel decoder — the same factory the player uses. */
  decoderFor: (channel: FoveaChannel) => Promise<FrameDecoder>;
  /** Resolved absolute ffmpeg path, or null (start then fails fast). */
  ffmpegPath: string | null;
  /** Parsed wide-camera calibration, or null (undistort unavailable). */
  calibration: Calibration | null;
  /** Push a fresh status snapshot to the renderer (spec 9 tray). */
  onUpdate: (overview: ExportOverview) => void;
}

interface JobRuntime {
  proc: ChildProcess | null;
  aborted: boolean;
  outputPath: string;
  tmpDir: string | null;
  /** Wall-clock start for fps/eta. */
  startedAt: number;
  framesWritten: number;
  totalFrames: number | null;
}

const PROGRESS_THROTTLE_MS = 250;

export class ExportRunner {
  private queue: ExportQueue;
  private runtimes = new Map<number, JobRuntime>();
  private lastPush = 0;

  constructor(private readonly deps: ExportRunnerDeps, parallel = false) {
    this.queue = new ExportQueue(parallel);
  }

  /** Enqueue + dispatch (spec 10). Returns the new job id. Rejects the whole
   *  start (marks it failed) when ffmpeg is unavailable. */
  start(request: ExportRequest): number {
    const { id, start } = this.queue.enqueue(request);
    for (const s of start) void this.launch(s);
    this.push(true);
    return id;
  }

  abort(id: number): void {
    const { wasRunning, start } = this.queue.abort(id);
    if (wasRunning) this.kill(id);
    for (const s of start) void this.launch(s);
    this.push(true);
  }

  abortAll(): void {
    for (const id of this.queue.abortAll()) this.kill(id);
    this.push(true);
  }

  setParallel(parallel: boolean): void {
    for (const s of this.queue.setParallel(parallel)) void this.launch(s);
    this.push(true);
  }

  clearFinished(): void {
    this.queue.clearFinished();
    this.push(true);
  }

  activeCount(): number {
    return this.queue.activeCount();
  }

  overview(): ExportOverview {
    return {
      jobs: this.queue.snapshot(),
      active: this.queue.activeCount(),
      overall: this.queue.overallProgress(),
    };
  }

  /** SIGKILL a running job's ffmpeg (the runtime unlinks the partial output when
   *  the process exits — spec 11). */
  private kill(id: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.aborted = true;
    rt.proc?.kill("SIGKILL");
  }

  private push(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastPush < PROGRESS_THROTTLE_MS) return;
    this.lastPush = now;
    this.deps.onUpdate(this.overview());
  }

  /** Launch the ffmpeg pipeline for a job the queue just moved to `running`. */
  private async launch(id: number): Promise<void> {
    const request = this.queue.request(id);
    if (!request) return;
    const rt: JobRuntime = {
      proc: null,
      aborted: false,
      outputPath: request.outputPath,
      tmpDir: null,
      startedAt: Date.now(),
      framesWritten: 0,
      totalFrames: null,
    };
    this.runtimes.set(id, rt);
    try {
      await this.runJob(id, request, rt);
      if (!rt.aborted) {
        for (const s of this.queue.complete(id, true)) void this.launch(s);
      }
    } catch (error) {
      if (!rt.aborted) {
        const msg = error instanceof Error ? error.message : String(error);
        for (const s of this.queue.complete(id, false, msg)) void this.launch(s);
      }
    } finally {
      if (rt.tmpDir) await rm(rt.tmpDir, { recursive: true, force: true }).catch(() => {});
      // Abort cleanup: remove the partial output (spec 11).
      if (rt.aborted) await unlink(rt.outputPath).catch(() => {});
      this.runtimes.delete(id);
      this.push(true);
    }
  }

  private async runJob(id: number, request: ExportRequest, rt: JobRuntime): Promise<void> {
    if (!this.deps.ffmpegPath) throw new Error("ffmpeg not found");
    const channel = this.deps.source.channels.find((c) => c.topic === request.channel);
    if (!channel) throw new Error(`no such stream "${request.channel}"`);
    const props = parseDecodeProps(channel.metadata);
    const height = props.shape[0] ?? 0;
    const width = props.shape[1] ?? 0;
    if (width <= 0 || height <= 0) throw new Error("stream has no frame geometry");
    const decode = await this.deps.decoderFor(channel);

    // Undistort: write the PGM16 remap maps to a temp dir (spec 4). Only valid
    // when calibration is present; the dialog gates this, but re-validate.
    let xmapPath: string | undefined;
    let ymapPath: string | undefined;
    if (request.undistort) {
      const cal: Calibration | null = this.deps.calibration;
      if (!cal) throw new Error("undistort requested but this recording has no calibration");
      rt.tmpDir = await mkdtemp(join(tmpdir(), "fovea-export-"));
      const { xPgm, yPgm } = remapMapsToPgm(buildRemapMaps(cal, width, height));
      xmapPath = join(rt.tmpDir, "xmap.pgm");
      ymapPath = join(rt.tmpDir, "ymap.pgm");
      await Promise.all([writeFile(xmapPath, xPgm), writeFile(ymapPath, yPgm)]);
    }

    const args = buildFfmpegArgs({ request, width, height, xmapPath, ymapPath });
    const proc = spawn(this.deps.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    rt.proc = proc;
    let stderrTail = "";
    proc.stderr?.on("data", (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    const stdin = proc.stdin!;
    // A broken pipe (ffmpeg died) surfaces as an error on stdin — swallow it so
    // the feed loop's write() rejects cleanly instead of crashing the engine.
    stdin.on("error", () => {});

    const exit = once(proc, "close") as Promise<[number | null]>;

    // Feed frames, then close stdin so ffmpeg finalizes.
    try {
      rt.totalFrames = await this.feed(id, request, channel, decode, width, height, stdin, rt);
    } finally {
      if (!stdin.destroyed) stdin.end();
    }

    const [code] = await exit;
    if (rt.aborted) return; // aborted: launch() unlinks; not a failure
    if (code !== 0)
      throw new Error(`ffmpeg exited with code ${code}${stderrTail ? `: …${stderrTail.slice(-300)}` : ""}`);
  }

  /** Decode + normalize + pipe every output frame; returns the total written.
   *  `as-is` streams frames sequentially; `resample` blends onto a uniform
   *  timebase (spec 7). Progress is metered off the frames we feed. */
  private async feed(
    id: number,
    request: ExportRequest,
    channel: FoveaChannel,
    decode: FrameDecoder,
    width: number,
    height: number,
    stdin: NodeJS.WritableStream,
    rt: JobRuntime,
  ): Promise<number> {
    const pixels = width * height;
    const toBuf = (mat: Mat<Uint8Array>): Uint8Array => toRGBA(mat, mat.channels, pixels);
    const write = async (buf: Uint8Array): Promise<void> => {
      if (rt.aborted) throw new Error("aborted");
      if (!stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)))
        await once(stdin, "drain");
      rt.framesWritten++;
      this.meter(id, rt);
    };

    if (request.normalize === "as-is") {
      // Sequential frames at the target fps (aligned-frame assumption).
      const counts = await this.deps.source.messageCounts().catch(() => new Map<string, number>());
      const total = counts.get(channel.topic) ?? null;
      rt.totalFrames = total;
      for await (const msg of this.deps.source.messages({ topics: [channel.topic] })) {
        if (rt.aborted) break;
        await write(toBuf(decode(msg.data)));
      }
      return total ?? rt.framesWritten;
    }

    // resample: uniform timebase + temporal blend. Two-pointer walk over the
    // decoded stream, emitting each sample between the straddling frames.
    const span = (await this.deps.source.channelSpans()).get(channel.topic);
    if (!span) return 0;
    const firstNs = Number(span.startNs);
    const lastNs = Number(span.endNs);
    const samples = uniformTimeline(firstNs, lastNs, request.fps);
    rt.totalFrames = samples.length;
    let si = 0;
    let prev: { ts: number; rgba: Uint8Array } | null = null;
    for await (const msg of this.deps.source.messages({ topics: [channel.topic] })) {
      if (rt.aborted) break;
      const ts = Number(msg.logTime);
      const rgba = toBuf(decode(msg.data));
      if (!prev) {
        // Drop samples before the first frame (nothing to blend from).
        while (si < samples.length && samples[si]! < ts) si++;
      } else {
        while (si < samples.length && samples[si]! <= ts) {
          const t = samples[si]!;
          if (t < prev.ts) { si++; continue; }
          const w = blendWeights(t, prev.ts, ts);
          await write(blendFrames(prev.rgba, rgba, w.prev, w.next));
          si++;
        }
      }
      prev = { ts, rgba };
    }
    // Trailing samples that land exactly on / after the last frame → last frame.
    while (!rt.aborted && si < samples.length && prev) {
      await write(prev.rgba);
      si++;
    }
    return samples.length;
  }

  /** Update the job's live fps/eta from wall-clock + frames written, throttled. */
  private meter(id: number, rt: JobRuntime): void {
    const elapsedSec = (Date.now() - rt.startedAt) / 1000;
    const fps = elapsedSec > 0 ? rt.framesWritten / elapsedSec : 0;
    const total = rt.totalFrames;
    const progress = total && total > 0 ? Math.min(1, rt.framesWritten / total) : null;
    const remaining = total ? Math.max(0, total - rt.framesWritten) : 0;
    const etaSec = total && fps > 0 ? remaining / fps : null;
    this.queue.progress(id, progress, fps, etaSec);
    this.push(false);
  }
}
