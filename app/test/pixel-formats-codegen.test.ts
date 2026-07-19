// Cross-language conformance for the pixel-format registry (B-P1/B-11): the
// C++ X-macro header (core/lib/Aravis/PixelFormat.gen.h) and the fcap (pyfcap) mirror
// (pyfcap/src/fcap/pixel_formats.py) are GENERATED from the single TS
// source (docs/schema/pixel-formats.ts) by a checked-in generator. Nothing
// re-runs that generator in CI, so this asserts the checked-in artifacts still
// match the source — catching a "edited the table, forgot to regenerate" drift
// that would silently desync host C++ / MCU / fcap decode. (C-P6's
// decode-conformance test covers TS↔d.ts; this covers TS↔generated C++/Python.)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PIXEL_FORMATS, cvBayerPrefix } from "../../docs/schema/pixel-formats.js";

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/** Rows of the C++ X-macro: `X(Name, ArvMacro, CvFormat, Bits, Packed)`. The
 *  leading-whitespace anchor skips the `// X-macro registry: X(Name, …)` doc. */
function cppRows() {
  const text = repoFile("core/lib/Aravis/PixelFormat.gen.h");
  const re = /^\s+X\(\s*([^,]+?),\s*([^,]+?),\s*([^,]+?),\s*(\d+),\s*(true|false)\s*\)/gm;
  return [...text.matchAll(re)].map((m) => ({
    name: m[1],
    aravis: m[2],
    cv: m[3],
    significantBits: Number(m[4]),
    isPacked: m[5] === "true",
  }));
}

/** Rows of the C++ `FOVEA_BAYER_CV_FORMATS(X)` macro: `X(FormatName, CvPrefix)`
 *  — the OpenCV demosaic prefix carrying the off-by-one R/B correction. */
function cppBayerCvRows() {
  const text = repoFile("core/lib/Aravis/PixelFormat.gen.h");
  const macro = text.slice(text.indexOf("#define FOVEA_BAYER_CV_FORMATS"));
  const re = /^\s+X\(\s*(Bayer[^,\s]+),\s*(Bayer[^,\s)]+)\s*\)/gm;
  return [...macro.matchAll(re)].map((m) => ({ name: m[1], cvPrefix: m[2] }));
}

/** Rows of the Python mirror's `PixelFormatSpec(...)` tuple. */
function pyRows() {
  const text = repoFile("pyfcap/src/fcap/pixel_formats.py");
  const re =
    /PixelFormatSpec\(name="([^"]+)", aravis="([^"]+)", cv="([^"]+)", dtype="([^"]+)", channels=(\d+), significant_bits=(\d+), is_packed=(True|False), bayer=(None|"[^"]+")\)/g;
  return [...text.matchAll(re)].map((m) => ({
    name: m[1],
    aravis: m[2],
    cv: m[3],
    dtype: m[4],
    channels: Number(m[5]),
    significantBits: Number(m[6]),
    isPacked: m[7] === "True",
    bayer: m[8] === "None" ? null : m[8].slice(1, -1),
  }));
}

describe("pixel-format registry codegen conformance (TS source ↔ generated C++/Python)", () => {
  it("generated C++ X-macro matches the TS source exactly", () => {
    const cpp = cppRows();
    expect(cpp).toHaveLength(PIXEL_FORMATS.length);
    PIXEL_FORMATS.forEach((spec, i) => {
      expect(cpp[i], spec.name).toEqual({
        name: spec.name,
        aravis: spec.aravis,
        cv: spec.cv,
        significantBits: spec.significantBits,
        isPacked: spec.isPacked,
      });
    });
  });

  it("generated FOVEA_BAYER_CV_FORMATS macro applies cvBayerPrefix for every Bayer format", () => {
    const rows = cppBayerCvRows();
    const bayerFormats = PIXEL_FORMATS.filter((f) => f.bayer !== null);
    expect(rows).toHaveLength(bayerFormats.length);
    bayerFormats.forEach((spec, i) => {
      expect(rows[i], spec.name).toEqual({
        name: spec.name,
        cvPrefix: cvBayerPrefix(spec.bayer!),
      });
    });
  });

  it("generated fcap mirror matches the TS source exactly", () => {
    const py = pyRows();
    expect(py).toHaveLength(PIXEL_FORMATS.length);
    PIXEL_FORMATS.forEach((spec, i) => {
      expect(py[i], spec.name).toEqual({
        name: spec.name,
        aravis: spec.aravis,
        cv: spec.cv,
        dtype: spec.dtype,
        channels: spec.channels,
        significantBits: spec.significantBits,
        isPacked: spec.isPacked,
        bayer: spec.bayer,
      });
    });
  });
});
