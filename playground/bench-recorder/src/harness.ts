// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

import { createRequire } from "node:module";
import type { CompressionInjection } from "../../../app/orchestrator/recorder/types.ts";
import type { FramePool } from "./synth.ts";

export type Compression = "none" | "lz4" | "zstd";

export interface BenchChannel {
  topic: string;
  fps: number;
  metadata: Record<string, string>;
  pool: readonly Uint8Array[];
}

export function parseArgs<T extends { [K in keyof T]: string | number | boolean }>(
  defaults: T,
  booleans: readonly (keyof T & string)[] = [],
): T {
  const map = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) map.set(m[1]!, m[2]!);
  }
  const out: T = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (!map.has(key)) continue;
    const value = map.get(key)!;
    if (booleans.includes(key)) {
      out[key] = (value === "1") as T[keyof T];
    } else if (typeof defaults[key] === "number") {
      out[key] = Number(value) as T[keyof T];
    } else {
      out[key] = value as T[keyof T];
    }
  }
  return out;
}

/** Resolve the bench-only compression injection from CLI args (never used in
 *  production — see CompressionInjection). Modules are resolved from the
 *  bench's own node_modules. */
export function compressionInjection(args: {
  compression: Compression;
  zstdLevel: number;
}): CompressionInjection | undefined {
  if (args.compression === "none") return undefined;
  const require = createRequire(import.meta.url);
  if (args.compression === "lz4") {
    return {
      name: "lz4",
      moduleEntry: require.resolve("lz4-napi"),
      exportName: "compressSync",
    };
  }
  return {
    name: "zstd",
    moduleEntry: require.resolve("zstd-napi"),
    exportName: "compress",
    level: args.zstdLevel,
  };
}

export function benchChannels(
  rawPool: FramePool,
  procPool: FramePool,
): BenchChannel[] {
  return [
    ...["cam0", "cam1", "cam2"].map((name) => ({
      topic: `raw/${name}`,
      fps: 60,
      metadata: {
        dtype: "U8",
        shape: JSON.stringify([rawPool.height, rawPool.width]),
        channels: "1",
        pixelFormat: "BayerRG12p",
        significantBits: "12",
      },
      pool: rawPool.frames,
    })),
    {
      topic: "processed/disparity",
      fps: 30,
      metadata: {
        dtype: "U8",
        shape: JSON.stringify([procPool.height, procPool.width]),
        channels: "1",
        pixelFormat: "Mono8",
        significantBits: "8",
      },
      pool: procPool.frames,
    },
  ];
}
