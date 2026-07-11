// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The app-level ANAGLYPH STYLE setting, orchestrator side (user ruling
// 2026-07-09). Reads the configured left-eye/right-eye color arrangement from
// the shared `["config"]` document — the same store-hub read pattern
// `record-compression.ts` uses (NOT `@lib/config`, which pulls Vue into this
// Vue-free process). Unlike the recording method (read once at RECORDING
// START), the style is LIVE: `subscribeAnaglyphStyle` rides the store-hub's
// in-process broadcast so a Settings change retunes the composite brick without
// a reconnect (disparity-scope session).
//
// The style union + validation live in `docs/schema/anaglyph.ts` — the SINGLE
// SOURCE OF TRUTH shared by every surface (cards, viewer, native brick). It is
// Vue-free, so — unlike the RecordCompression union `record-compression.ts` had
// to duplicate — this module imports it directly and cannot drift.

import { read, subscribe } from "./store-hub.js";
import { APP_CONFIG_PATH } from "@lib/config-schema";
import {
  coerceAnaglyphStyle,
  DEFAULT_ANAGLYPH_STYLE,
  type AnaglyphStyle,
} from "../../docs/schema/anaglyph.js";

/** The shared app config doc path (re-export of `@lib/config-schema`'s
 *  `APP_CONFIG_PATH` under this reader's historical name). */
export const ANAGLYPH_STYLE_CONFIG_PATH = APP_CONFIG_PATH;

/** Read the configured anaglyph style (store-hub cache). Defaults to `"RC"` on
 *  an unset key, an unknown value, or a read fault (a config hiccup must never
 *  break the composite — it degrades to the historical red-left/cyan-right). */
export async function readAnaglyphStyle(): Promise<AnaglyphStyle> {
  try {
    const cfg = await read<{ anaglyph_style?: unknown }>(
      ANAGLYPH_STYLE_CONFIG_PATH,
      {},
    );
    return coerceAnaglyphStyle(cfg.anaglyph_style);
  } catch {
    return DEFAULT_ANAGLYPH_STYLE;
  }
}

/** Subscribe to LIVE anaglyph-style changes (store-hub broadcast). `cb` fires
 *  only when the coerced style actually CHANGES from `initial` (dedupe: a config
 *  write to an unrelated key re-broadcasts the whole doc). Returns an
 *  unsubscribe. Pair with {@link readAnaglyphStyle} for the current value and
 *  pass it as `initial` so an unrelated first write doesn't fire a redundant
 *  retune. */
export function subscribeAnaglyphStyle(
  cb: (style: AnaglyphStyle) => void,
  initial: AnaglyphStyle | null = null,
): () => void {
  let last = initial;
  return subscribe(ANAGLYPH_STYLE_CONFIG_PATH, (value) => {
    const style = coerceAnaglyphStyle(
      (value as { anaglyph_style?: unknown } | undefined)?.anaglyph_style,
    );
    if (style === last) return;
    last = style;
    cb(style);
  });
}
