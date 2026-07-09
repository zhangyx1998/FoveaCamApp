// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Trivial emitter for the B-P1 pixel-format registry. Reads the single source
// table (pixel-formats.ts) and (re)writes the checked-in C++ header + Python
// mirror. NOT wired into any build — run by hand after editing the table:
//   /opt/homebrew/bin/node docs/schema/generate-pixel-formats.ts
// then commit the regenerated artifacts alongside the table. The C++ header is
// passed through clang-format (matching the repo pre-commit hook) so the
// emitted file is byte-identical to what lands in a commit.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PIXEL_FORMATS, BAYER_PATTERNS } from "./pixel-formats.ts";
import {
  DEFAULT_CHUNK_BYTES,
  DEFAULT_MAX_QUEUED_FRAMES,
  FINALIZE_METADATA_NAME,
  FOVEA_EXTENSION,
  FOVEA_LIBRARY,
  FOVEA_PROFILE,
  FRAME_METADATA_KEYS,
  JSON_SCHEMA_ENCODING,
  RAW_FRAME_MESSAGE_ENCODING,
  RAW_FRAME_SCHEMA_DATA,
  RAW_FRAME_SCHEMA_NAME,
  SESSION_METADATA_NAME,
  TELEMETRY_MESSAGE_ENCODING,
  TELEMETRY_SCHEMA_DATA,
  TELEMETRY_SCHEMA_NAME,
  TELEMETRY_TOPIC,
} from "./fovea.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

// ---- C++ header (X-macro) ------------------------------------------------
// Consumers expand FOVEA_PIXEL_FORMATS(X) with X(Name, ArvMacro, CvFormat,
// SignificantBits, IsPacked). Row order fixes the enum's uint8_t values.
const cppRows = PIXEL_FORMATS.map(
  (f) =>
    `  X(${f.name}, ${f.aravis}, ${f.cv}, ${f.significantBits}, ${f.isPacked}) \\`,
);
const cpp = [
  "// GENERATED from docs/schema/pixel-formats.ts by",
  "// docs/schema/generate-pixel-formats.ts — DO NOT EDIT BY HAND.",
  "// Edit the source table and rerun the generator, then commit both.",
  "#pragma once",
  "",
  "// X-macro registry: X(Name, ArvMacro, CvFormat, SignificantBits, IsPacked).",
  "// GenICam 12p formats (IsPacked=true) carry 12 significant bits in a 16-bit",
  "// container and unpack to CV_16UC1; display scaling uses 4095, not 65535.",
  "#define FOVEA_PIXEL_FORMATS(X) \\",
  ...cppRows,
  "",
  "",
].join("\n");
const cppPath = resolve(repo, "core/lib/Aravis/PixelFormat.gen.h");
writeFileSync(cppPath, cpp);
try {
  execFileSync("clang-format", ["-i", cppPath], { stdio: "pipe" });
} catch (err) {
  console.warn(
    "warning: clang-format not run on PixelFormat.gen.h — the pre-commit hook will reformat it:",
    (err as Error).message,
  );
}

// ---- Python mirror -------------------------------------------------------
const pyRows = PIXEL_FORMATS.map((f) => {
  const bayer = f.bayer === null ? "None" : `"${f.bayer}"`;
  return (
    `    PixelFormatSpec(name="${f.name}", aravis="${f.aravis}", cv="${f.cv}", ` +
    `dtype="${f.dtype}", channels=${f.channels}, ` +
    `significant_bits=${f.significantBits}, is_packed=${f.isPacked ? "True" : "False"}, bayer=${bayer}),`
  );
});
const py = [
  "# GENERATED from docs/schema/pixel-formats.ts by",
  "# docs/schema/generate-pixel-formats.ts — DO NOT EDIT BY HAND.",
  "# Edit the source table and rerun the generator, then commit both.",
  '"""Mirror of docs/schema/pixel-formats.ts — the sensor pixel-format registry.',
  "",
  "The single source is the TS table; this checked-in mirror lets fcap consume",
  "the same format facts without importing app code (same pattern as schema.py).",
  '"""',
  "",
  "from __future__ import annotations",
  "",
  "from typing import NamedTuple, Optional",
  "",
  "",
  "class PixelFormatSpec(NamedTuple):",
  "    name: str",
  "    aravis: str",
  "    cv: str",
  "    dtype: str",
  "    channels: int",
  "    significant_bits: int",
  "    is_packed: bool",
  "    bayer: Optional[str]",
  "",
  "",
  "PIXEL_FORMATS: tuple[PixelFormatSpec, ...] = (",
  ...pyRows,
  ")",
  "",
  "#: All canonical format names, in registry order.",
  "PIXEL_FORMAT_NAMES: tuple[str, ...] = tuple(f.name for f in PIXEL_FORMATS)",
  "",
  "#: Distinct Bayer mosaic prefixes, in first-seen order.",
  `BAYER_PATTERNS: tuple[str, ...] = (${BAYER_PATTERNS.map((b) => `"${b}"`).join(", ")},)`,
  "",
  "_BY_NAME = {f.name: f for f in PIXEL_FORMATS}",
  "",
  "",
  "def pixel_format_spec(name: str) -> Optional[PixelFormatSpec]:",
  '    """Look up a format spec by name (None if unknown)."""',
  "    return _BY_NAME.get(name)",
  "",
].join("\n");
writeFileSync(resolve(repo, "pyfcap/src/fcap/pixel_formats.py"), py);

// ---- Python .fovea schema mirror ----------------------------------------
function pyString(value: string): string {
  return JSON.stringify(value);
}

function pyTuple(values: readonly string[]): string[] {
  return values.map((value) => `    ${pyString(value)},`);
}

const rawFrameDescription = JSON.parse(RAW_FRAME_SCHEMA_DATA).description;
const telemetryDescription = JSON.parse(TELEMETRY_SCHEMA_DATA).description;
const rawFrameChunks = [
  "Raw frame bytes exactly as captured (12p formats stay ",
  "packed). Decode props are in the channel metadata.",
];
const telemetryChunks = [
  "Per-frame JSON metadata document: {stream, seq, t, ",
  "...extras} — extras are the legacy .meta sidecar's `x` payload ",
  "(volt/angle/affine). Correlate with the frame by stream+seq (or ",
  "logTime).",
];
if (rawFrameChunks.join("") !== rawFrameDescription) {
  throw new Error("RAW_FRAME_SCHEMA_DATA description wrapping is stale");
}
if (telemetryChunks.join("") !== telemetryDescription) {
  throw new Error("TELEMETRY_SCHEMA_DATA description wrapping is stale");
}
const schemaPy = [
  "# ------------------------------------------------------",
  "# Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc",
  "# This source code is licensed under the MIT license.",
  "# You may find the full license in project root directory.",
  "# -------------------------------------------------------",
  '"""Mirrored constants for the recorder-container.md §2b ``.fovea`` schema."""',
  "",
  "from __future__ import annotations",
  "",
  "import json",
  "",
  `FOVEA_EXTENSION = ${pyString(FOVEA_EXTENSION)}`,
  `FOVEA_PROFILE = ${pyString(FOVEA_PROFILE)}`,
  `FOVEA_LIBRARY = ${pyString(FOVEA_LIBRARY)}`,
  "",
  `TELEMETRY_TOPIC = ${pyString(TELEMETRY_TOPIC)}`,
  `RAW_FRAME_SCHEMA_NAME = ${pyString(RAW_FRAME_SCHEMA_NAME)}`,
  `TELEMETRY_SCHEMA_NAME = ${pyString(TELEMETRY_SCHEMA_NAME)}`,
  `JSON_SCHEMA_ENCODING = ${pyString(JSON_SCHEMA_ENCODING)}`,
  `RAW_FRAME_MESSAGE_ENCODING = ${pyString(RAW_FRAME_MESSAGE_ENCODING)}`,
  `TELEMETRY_MESSAGE_ENCODING = ${pyString(TELEMETRY_MESSAGE_ENCODING)}`,
  "",
  `SESSION_METADATA_NAME = ${pyString(SESSION_METADATA_NAME)}`,
  `FINALIZE_METADATA_NAME = ${pyString(FINALIZE_METADATA_NAME)}`,
  "",
  `DEFAULT_CHUNK_BYTES = ${DEFAULT_CHUNK_BYTES / 1024} * 1024`,
  `DEFAULT_MAX_QUEUED_FRAMES = ${DEFAULT_MAX_QUEUED_FRAMES}`,
  "",
  "RAW_FRAME_SCHEMA_DATA = json.dumps(",
  "    {",
  `        "description": ${pyString(rawFrameChunks[0])}`,
  `        ${pyString(rawFrameChunks[1])}`,
  "    }",
  ").encode()",
  "",
  "TELEMETRY_SCHEMA_DATA = json.dumps(",
  "    {",
  `        "description": ${pyString(telemetryChunks[0])}`,
  `        ${pyString(telemetryChunks[1])}`,
  `        ${pyString(telemetryChunks[2])}`,
  `        ${pyString(telemetryChunks[3])}`,
  "    }",
  ").encode()",
  "",
  "FRAME_METADATA_KEYS = (",
  ...pyTuple(FRAME_METADATA_KEYS),
  ")",
  "",
  "",
].join("\n");
writeFileSync(resolve(repo, "pyfcap/src/fcap/schema.py"), schemaPy);

console.log(
  `wrote core/lib/Aravis/PixelFormat.gen.h, pyfcap/src/fcap/pixel_formats.py, and pyfcap/src/fcap/schema.py (${PIXEL_FORMATS.length} formats)`,
);
