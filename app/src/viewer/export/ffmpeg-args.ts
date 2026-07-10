// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE ffmpeg argv builder for the viewer video export (viewer-export.md
// pipeline). Given a resolved `ExportRequest` + frame geometry (+ the remap
// PGM16 map paths when undistort is on) it produces the argument vector for the
// resolved ffmpeg binary — no spawning, no fs, so the exact command line is
// unit-tested (test/viewer-export.test.ts). The engine's export-runner passes
// the result straight to `spawn(ffmpegPath, args)`.
//
// Shape (spec pipeline): decoded frames are normalized to RAW `rgba` and piped
// on stdin; `-f rawvideo -pix_fmt rgba -s WxH -r FPS -i -`. Undistort adds the
// two map inputs + a `remap` filter whose FILL is transparent (alpha on) or
// black (alpha off / unsupported). Output codec/pixfmt/container come from the
// codec table.

import { codec, type CodecId } from "./codecs.js";
import type { ExportRequest } from "./types.js";

export interface FfmpegArgsInput {
  request: ExportRequest;
  /** Source frame width/height (px) — the rawvideo geometry. */
  width: number;
  height: number;
  /** Raw input pixel format piped on stdin (always `rgba` today; documented so
   *  a future gray16le path is a one-liner). */
  inputPixFmt?: string;
  /** X/Y PGM16 map paths — REQUIRED when `request.undistort` is true. */
  xmapPath?: string;
  ymapPath?: string;
}

/** Per-codec output-quality + muxing flags (kept conservative + visually
 *  near-lossless — an export is an archival/authoring artifact, not a stream). */
function encoderArgs(codecId: CodecId, request: ExportRequest): string[] {
  switch (codecId) {
    case "prores": {
      const spec = codec("prores");
      const prof = spec.profiles!.find((p) => p.id === request.profile) ?? spec.profiles![0]!;
      return ["-profile:v", String(prof.profile)];
    }
    case "x264":
      return ["-preset", "medium", "-crf", "17"];
    case "x265":
      // hvc1 tag keeps the mp4 playable in QuickTime.
      return ["-preset", "medium", "-crf", "20", "-tag:v", "hvc1"];
    case "vp9":
      return ["-crf", "24", "-b:v", "0", "-row-mt", "1"];
    case "av1":
      return ["-preset", "8", "-crf", "30"];
  }
}

/** Build the full ffmpeg argument vector (excludes the binary path). Throws when
 *  undistort is requested without map paths (a programmer error — the runner
 *  writes the maps first). */
export function buildFfmpegArgs(input: FfmpegArgsInput): string[] {
  const { request, width, height } = input;
  const inputPixFmt = input.inputPixFmt ?? "rgba";
  const spec = codec(request.codec);

  const args: string[] = [
    "-y", // overwrite (the save dialog already confirmed the target)
    "-f", "rawvideo",
    "-pix_fmt", inputPixFmt,
    "-s", `${width}x${height}`,
    "-r", String(request.fps),
    "-i", "-", // frames on stdin
  ];

  if (request.undistort) {
    if (!input.xmapPath || !input.ymapPath)
      throw new Error("buildFfmpegArgs: undistort requires xmapPath + ymapPath");
    // Two map inputs + a remap filter. Fill = transparent when alpha is on, else
    // opaque black (the OOB regions then encode as black in a non-alpha pixfmt).
    const fill = request.alpha ? "black@0.0" : "black";
    args.push("-i", input.xmapPath, "-i", input.ymapPath);
    args.push("-filter_complex", `[0:v][1:v][2:v]remap=fill=${fill}[v]`);
    args.push("-map", "[v]");
  }

  args.push("-an"); // no audio
  args.push("-c:v", spec.encoder);
  args.push(...encoderArgs(request.codec, request));
  args.push("-pix_fmt", request.pixfmt);
  // Progress on stderr is parsed by the runner; make it line-buffered + verbose
  // enough to carry `frame=`.
  args.push("-progress", "pipe:2", "-nostats");
  args.push(request.outputPath);
  return args;
}
