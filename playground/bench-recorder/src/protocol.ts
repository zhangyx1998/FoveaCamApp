// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Main <-> writer-worker message shapes for the MCAP recorder bench. Mirrors
// the shape of app/orchestrator/stream-writer.ts (bounded handoff, transfer
// of ArrayBuffers, ack-based backpressure) but multiplexes N channels into a
// single MCAP file/worker instead of one worker per stream, since the new
// container format's whole point is one file per recording session.

export type Compression = "none" | "lz4" | "zstd";

export interface ChannelSpec {
  topic: string;
  schemaName: string;
  metadata: Record<string, string>;
}

export type WorkerIn =
  | {
      type: "init";
      filePath: string;
      chunkSize: number;
      compression: Compression;
      zstdLevel?: number;
      channels: ChannelSpec[];
    }
  | {
      type: "frame";
      topic: string;
      seq: number;
      logTimeNs: bigint;
      data: ArrayBuffer;
    }
  | { type: "metrics-request" }
  | { type: "stop" };

export type WorkerOut =
  | { type: "ready" }
  | { type: "ack"; topic: string }
  | {
      type: "metrics";
      rss: number;
      heapUsed: number;
      cpuUserUs: number;
      cpuSystemUs: number;
      written: number;
      bytesWritten: number;
    }
  | {
      type: "stopped";
      written: number;
      bytesWritten: number;
      fileBytes: number;
      chunkCount: number;
      messageCount: string; // bigint stringified
      /** whole-run worker-thread CPU usage (process.cpuUsage() diffed against
       * a baseline taken at worker startup) - authoritative, unlike the
       * periodic "metrics" samples which can have gaps if the worker's
       * event loop is saturated. */
      cpuUserUs: number;
      cpuSystemUs: number;
    }
  | { type: "error"; message: string; stack?: string };
