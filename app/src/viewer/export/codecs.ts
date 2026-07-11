// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The viewer export option matrix (codec → container/pixfmt/alpha/profile) as
// ONE pure data table read by both the args builder and the dialog, so the UI
// never offers what the args builder can't produce. Renderer-safe + Node-free.
// spec: docs/spec/viewer.md#export

/** One selectable pixel format for a codec. `alpha` = the format carries an
 *  alpha plane (transparency is only offerable when the chosen pixfmt supports
 *  it — viewer-export spec 5). `bits` documents the sample depth (8/10). */
export interface PixFmtOption {
  /** ffmpeg `-pix_fmt` value (the OUTPUT pixel format). */
  id: string;
  /** Human label for the dialog. */
  label: string;
  /** True when this pixel format carries an alpha plane. */
  alpha: boolean;
  /** Sample bit depth (8 or 10) — shown in the dialog, not passed to ffmpeg. */
  bits: number;
}

/** A ProRes profile (prores_ks `-profile:v`). Meaningful subset per spec 2. */
export interface ProResProfile {
  id: string;
  label: string;
  /** prores_ks numeric profile. */
  profile: number;
}

export type CodecId = "prores" | "x264" | "x265" | "vp9" | "av1";

export interface CodecSpec {
  id: CodecId;
  label: string;
  /** ffmpeg encoder name (`-c:v`). */
  encoder: string;
  /** Output container extension (no dot) — mov for ProRes, mp4 for x264/x265,
   *  webm for VP9/AV1 (spec 2). */
  container: string;
  /** Allowed output pixel formats (first = default unless `defaultPixFmt`). */
  pixfmts: PixFmtOption[];
  /** Default pixel format id (spec 3). */
  defaultPixFmt: string;
  /** ProRes profiles (only for `prores`). */
  profiles?: ProResProfile[];
  /** Default profile id (only for `prores`). */
  defaultProfile?: string;
}

const PRORES_422: PixFmtOption = { id: "yuv422p10le", label: "YUV 4:2:2 10-bit", alpha: false, bits: 10 };
const PRORES_4444: PixFmtOption = { id: "yuva444p10le", label: "YUVA 4:4:4 10-bit (alpha)", alpha: true, bits: 10 };

/** The export codec table (spec 2/3/5). ORDER is the dialog order. */
export const CODECS: readonly CodecSpec[] = [
  {
    id: "prores",
    label: "ProRes",
    encoder: "prores_ks",
    container: "mov",
    // 422/422 HQ carry no alpha; 4444 does. The dialog filters the pixfmt list
    // by the selected profile (see `pixfmtsFor`).
    pixfmts: [PRORES_422, PRORES_4444],
    defaultPixFmt: PRORES_422.id,
    profiles: [
      { id: "422", label: "422", profile: 2 },
      { id: "422hq", label: "422 HQ", profile: 3 },
      { id: "4444", label: "4444", profile: 4 },
    ],
    defaultProfile: "422",
  },
  {
    id: "x264",
    label: "H.264 (x264)",
    encoder: "libx264",
    container: "mp4",
    pixfmts: [
      { id: "yuv420p", label: "YUV 4:2:0 8-bit", alpha: false, bits: 8 },
      { id: "yuv444p", label: "YUV 4:4:4 8-bit", alpha: false, bits: 8 },
    ],
    defaultPixFmt: "yuv420p",
  },
  {
    id: "x265",
    label: "H.265 (x265)",
    encoder: "libx265",
    container: "mp4",
    pixfmts: [
      { id: "yuv420p", label: "YUV 4:2:0 8-bit", alpha: false, bits: 8 },
      { id: "yuv444p", label: "YUV 4:4:4 8-bit", alpha: false, bits: 8 },
      { id: "yuv420p10le", label: "YUV 4:2:0 10-bit", alpha: false, bits: 10 },
      { id: "yuv444p10le", label: "YUV 4:4:4 10-bit", alpha: false, bits: 10 },
    ],
    defaultPixFmt: "yuv420p",
  },
  {
    id: "vp9",
    label: "VP9 (WebM)",
    encoder: "libvpx-vp9",
    container: "webm",
    pixfmts: [
      { id: "yuv420p", label: "YUV 4:2:0 8-bit", alpha: false, bits: 8 },
      { id: "yuva420p", label: "YUVA 4:2:0 8-bit (alpha)", alpha: true, bits: 8 },
    ],
    defaultPixFmt: "yuv420p",
  },
  {
    id: "av1",
    label: "AV1 (WebM)",
    encoder: "libsvtav1",
    container: "webm",
    // SVT-AV1 supports 8- and 10-bit 4:2:0; no alpha in the common encoders, so
    // transparency is never offerable for AV1 (the dialog disables it with a
    // reason from `alphaSupported`).
    pixfmts: [
      { id: "yuv420p", label: "YUV 4:2:0 8-bit", alpha: false, bits: 8 },
      { id: "yuv420p10le", label: "YUV 4:2:0 10-bit", alpha: false, bits: 10 },
    ],
    defaultPixFmt: "yuv420p",
  },
];

const CODEC_BY_ID = new Map(CODECS.map((c) => [c.id, c]));

/** Look up a codec spec by id (throws for an unknown id — a programmer error,
 *  the UI only ever offers the table's own ids). */
export function codec(id: CodecId): CodecSpec {
  const c = CODEC_BY_ID.get(id);
  if (!c) throw new Error(`unknown export codec "${id}"`);
  return c;
}

/** The pixel formats offerable for a codec, filtered by the ProRes profile when
 *  relevant: ProRes 422 / 422 HQ expose only the 4:2:2 pixfmt, ProRes 4444
 *  exposes only the alpha 4:4:4 pixfmt (spec 3). Non-ProRes codecs ignore
 *  `profileId` and return their full list. */
export function pixfmtsFor(codecId: CodecId, profileId?: string): PixFmtOption[] {
  const c = codec(codecId);
  if (c.id !== "prores") return [...c.pixfmts];
  return profileId === "4444" ? [PRORES_4444] : [PRORES_422];
}

/** The default pixfmt for a codec + optional ProRes profile — the first entry
 *  of `pixfmtsFor` (so the default always agrees with what the dialog shows). */
export function defaultPixfmtFor(codecId: CodecId, profileId?: string): string {
  return pixfmtsFor(codecId, profileId)[0]!.id;
}

/** Whether a given codec+pixfmt combination carries alpha (transparency is only
 *  selectable when this is true — spec 5). Unknown pixfmt ⇒ false. */
export function alphaSupported(codecId: CodecId, pixfmtId: string): boolean {
  return codec(codecId).pixfmts.find((p) => p.id === pixfmtId)?.alpha ?? false;
}

/** Output container extension for a codec (spec 2). */
export function containerFor(codecId: CodecId): string {
  return codec(codecId).container;
}

/** Default file basename for an export: `<recording>-<stream>` with unsafe path
 *  characters folded to `_` (spec 8). The stream topic can carry `/` (e.g.
 *  `camera/A/raw`) — collapse those so the suggested filename is a single
 *  path segment. */
export function defaultExportBasename(recording: string, stream: string): string {
  const safe = (s: string) => s.replace(/[/\\:]+/g, "_").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `${safe(recording)}-${safe(stream)}`;
}
