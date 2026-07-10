// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// PURE stream-statistics model for the standalone viewer's right-click stats
// popover. No Vue, no Node, no core — just the assembly of a channel's STATIC
// container stats out of the already-open `ViewerChannelInfo` (metadata + block
// span + per-channel message count shipped in the `opened` payload) plus the
// number/time formatting helpers and the popover clamp math, so every piece is
// unit-tested in isolation (app/test/viewer-stats.test.ts).
//
// LIVE stats (decode rate / frames decoded / last-shown frame timestamp) are the
// engine's — they come back over the `get-stats`→`stats` request as
// `StreamLiveStats` (protocol.ts); this module only FORMATS them.

import type { StreamLiveStats, ViewerChannelInfo } from "./protocol.js";

/** The static half of one stream's stats — everything derivable renderer-side
 *  from the container/channel info, no engine round-trip. */
export interface StreamStaticStats {
  name: string;
  /** Base pixel format (codec suffixes split off into `codec`). */
  pixelFormat: string;
  /** Significant bit depth (8/12/16…); 0 when the channel isn't a frame track. */
  significantBits: number;
  /** Codec suffix chain (`zlib`, or `a/b`), or null for a raw wire. */
  codec: string | null;
  width: number;
  height: number;
  channels: number;
  /** Messages on this channel over the file, or null when the container did not
   *  expose a count cheaply (no statistics summary). */
  messageCount: number | null;
  /** This channel's block span [first,last] in ns (0 when it carried nothing). */
  spanNs: number;
  /** Average frames/second across the span, or null when it can't be computed
   *  (< 2 messages or a zero span). */
  avgFps: number | null;
}

/** Split a `pixelFormat` on `/` into its base format and the codec-suffix chain
 *  (leftmost applied first). Kept local so this module stays free of decode.ts's
 *  node:zlib import — it must be importable by the renderer popover. */
export function splitBaseCodecs(pixelFormat: string): { base: string; codecs: string[] } {
  const parts = pixelFormat.split("/");
  return { base: parts[0] ?? "", codecs: parts.slice(1) };
}

/** Average fps of `count` messages spread over `spanNs`. Uses the (count-1)
 *  intervals over the span — evenly spaced frames at 100 ms give exactly 10 fps.
 *  null when it can't be computed (< 2 messages or a non-positive span). */
export function computeAvgFps(count: number | null, spanNs: number): number | null {
  if (count == null || count < 2 || !(spanNs > 0)) return null;
  return (count - 1) / (spanNs / 1e9);
}

/** Assemble the STATIC stats for one frame channel from its `ViewerChannelInfo`
 *  (metadata + block span + message count). Defensive: a channel with malformed
 *  or missing decode metadata still yields a (mostly-zero) record instead of
 *  throwing — the popover shows what it can. */
export function assembleStaticStats(info: ViewerChannelInfo): StreamStaticStats {
  const md = info.metadata ?? {};
  const { base, codecs } = splitBaseCodecs(md.pixelFormat ?? "");
  let shape: number[] = [];
  try {
    const parsed = JSON.parse(md.shape ?? "[]") as unknown;
    if (Array.isArray(parsed)) shape = parsed.filter((n): n is number => typeof n === "number");
  } catch {
    /* leave shape empty */
  }
  const height = shape[0] ?? 0;
  const width = shape[1] ?? 0;
  const spanNs =
    info.startNs != null && info.lastNs != null ? Math.max(0, info.lastNs - info.startNs) : 0;
  const messageCount = typeof info.messageCount === "number" ? info.messageCount : null;
  return {
    name: info.name,
    pixelFormat: base,
    significantBits: Number(md.significantBits ?? "0") || 0,
    codec: codecs.length > 0 ? codecs.join("/") : null,
    width,
    height,
    channels: Number(md.channels ?? "1") || 1,
    messageCount,
    spanNs,
    avgFps: computeAvgFps(messageCount, spanNs),
  };
}

// ---- formatters -----------------------------------------------------------

/** Human duration for a ns span: "12.3 s" under 100 s, "M:SS" above. */
export function formatDuration(ns: number): string {
  if (!Number.isFinite(ns) || ns <= 0) return "0.0 s";
  const s = ns / 1e9;
  if (s < 100) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}:${String(rem).padStart(2, "0")}`;
}

/** "29.97 fps", or "—" for an absent/non-finite rate. */
export function formatFps(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(2)} fps`;
}

/** "1280 × 720", or "—" when unknown. */
export function formatResolution(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width} × ${height}` : "—";
}

/** Pixel-format + bit-depth line: "BayerRG12p · 12-bit" (bit depth omitted when
 *  unknown, codec appended as "· /zlib" when present). */
export function formatPixelFormat(s: StreamStaticStats): string {
  const parts = [s.pixelFormat || "—"];
  if (s.significantBits > 0) parts.push(`${s.significantBits}-bit`);
  if (s.codec) parts.push(`/${s.codec}`);
  return parts.join(" · ");
}

/** Format a rendered live-stats snapshot (null → all placeholders). */
export function formatLive(live: StreamLiveStats | null): {
  decoded: string;
  rate: string;
  lastFrame: string;
} {
  if (!live) return { decoded: "…", rate: "…", lastFrame: "…" };
  return {
    decoded: String(live.decoded),
    rate: formatFps(live.rateHz),
    lastFrame: live.lastFrameNs == null ? "—" : formatDuration(live.lastFrameNs),
  };
}

// ---- popover placement ----------------------------------------------------

/** Clamp a popover of size `w×h` anchored at `(x,y)` so it stays fully inside a
 *  `winW×winH` viewport with a `margin` gutter (layout stability: it never
 *  spills off-window). Prefers the anchor, shifts left/up only as needed. */
export function clampPopover(
  x: number,
  y: number,
  w: number,
  h: number,
  winW: number,
  winH: number,
  margin = 8,
): { x: number; y: number } {
  let px = x;
  let py = y;
  if (px + w + margin > winW) px = winW - w - margin;
  if (py + h + margin > winH) py = winH - h - margin;
  return { x: Math.max(margin, px), y: Math.max(margin, py) };
}
