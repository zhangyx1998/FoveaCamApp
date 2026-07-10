// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The app-level RECORDING COMPRESSION setting, orchestrator side (user directive
// 2026-07-09). Reads the configured method from the shared `["config"]` document
// at RECORDING START — the same store-hub read pattern the calibrate-extrinsic
// capture uses for the marker sizes (NOT `@lib/config`, which pulls Vue into
// this Vue-free process). Applies to NEW recordings; a running recording keeps
// the method it started with.
//
// The union is DUPLICATED from `@lib/config`'s `RecordCompression` (the renderer
// half surfaces it in Settings) so the orchestrator never imports the Vue-touching
// module — keep the two in sync (extensible: more methods may come, none now).

import { read } from "./store-hub.js";

/** Recording compression method (extensible union). Mirrors
 *  `AppConfig.record_compression` in `@lib/config`. */
export type RecordCompression = "none" | "zlib";

/** The shared app config doc path (mirrors `APP_CONFIG_PATH` in `@lib/config`). */
export const RECORD_COMPRESSION_CONFIG_PATH = ["config"];

/** Read the configured recording compression method (store-hub cache). Called at
 *  RECORDING START. Defaults to `"none"` on an unset key, an unknown value, or a
 *  read fault (a config hiccup must never break a recording — it degrades to the
 *  historical uncompressed behavior). */
export async function readRecordCompression(): Promise<RecordCompression> {
  try {
    const cfg = await read<{ record_compression?: RecordCompression }>(
      RECORD_COMPRESSION_CONFIG_PATH,
      {},
    );
    return cfg.record_compression === "zlib" ? "zlib" : "none";
  } catch {
    return "none";
  }
}
