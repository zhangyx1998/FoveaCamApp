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
  "The single source is the TS table; this checked-in mirror lets pyfovea consume",
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
writeFileSync(resolve(repo, "pyfovea/src/pyfovea/pixel_formats.py"), py);

console.log(
  `wrote core/lib/Aravis/PixelFormat.gen.h and pyfovea/src/pyfovea/pixel_formats.py (${PIXEL_FORMATS.length} formats)`,
);
