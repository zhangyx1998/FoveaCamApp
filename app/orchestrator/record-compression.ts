// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The app-level recording-compression setting, orchestrator side: reads the method from
// the shared ["config"] doc at RECORDING START via store-hub (NOT @lib/config, which pulls
// Vue into this Vue-free process). Applies to NEW recordings; a running one keeps its
// method. The union/default/validation live in the shared Vue-free @lib/config-schema so
// the two halves can't drift.
// spec: docs/spec/capture-recording.md#record-compression

import { read } from "./store-hub.js";
import {
  APP_CONFIG_PATH,
  coerceRecordCompression,
  DEFAULT_RECORD_COMPRESSION,
  type RecordCompression,
} from "@lib/config-schema";

export type { RecordCompression };

/** The shared app config doc path (re-export of `@lib/config-schema`'s
 *  `APP_CONFIG_PATH` under this reader's historical name). */
export const RECORD_COMPRESSION_CONFIG_PATH = APP_CONFIG_PATH;

/** Read the configured recording compression method (store-hub cache). Called at
 *  RECORDING START. Defaults to `"none"` on an unset key, an unknown value, or a
 *  read fault (a config hiccup must never break a recording — it degrades to the
 *  historical uncompressed behavior). */
export async function readRecordCompression(): Promise<RecordCompression> {
  try {
    const cfg = await read<{ record_compression?: unknown }>(
      RECORD_COMPRESSION_CONFIG_PATH,
      {},
    );
    return coerceRecordCompression(cfg.record_compression);
  } catch {
    return DEFAULT_RECORD_COMPRESSION;
  }
}
