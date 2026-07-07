// C-P6: the TS decode side of the single pixel-format registry (B-P1). Pins
// that the viewer/display decode helpers consume `docs/schema/pixel-formats`
// and can't drift from the format facts (which also drive the C++ tables and
// pyfovea training decode). Consume/assert only — no metadata-name changes.
//
// Per B-P1's conformance note: `PixelFormatSpec.name` is typed `string`, not a
// literal union, so the guard against the `core/Aravis` d.ts union is a runtime
// VALUE-set comparison (not a type-level assert).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PIXEL_FORMATS,
  PIXEL_FORMAT_NAMES,
  pixelFormatSpec,
} from "../../docs/schema/pixel-formats.js";
import { significantBits } from "@lib/util/dtype";
import { bayerCode } from "@orchestrator/viewer/decode";

describe("decode conformance vs docs/schema/pixel-formats (C-P6)", () => {
  it("dtype.significantBits matches the schema for every format", () => {
    for (const name of PIXEL_FORMAT_NAMES) {
      const spec = pixelFormatSpec(name)!;
      expect(significantBits(name as never)).toBe(spec.significantBits);
    }
  });

  it("decode.bayerCode matches the schema's bayer field for every format", () => {
    for (const spec of PIXEL_FORMATS) {
      const expected = spec.bayer ? `${spec.bayer}2RGB` : null;
      expect(bayerCode(spec.name)).toBe(expected);
    }
  });

  it("non-Bayer / unknown formats produce no demosaic code", () => {
    expect(bayerCode("Mono8")).toBeNull();
    expect(bayerCode("Mono12p")).toBeNull();
    expect(bayerCode("RGB8")).toBeNull();
    expect(bayerCode("NotAFormat")).toBeNull();
  });

  it("schema name set equals the core/Aravis PixelFormat d.ts union (values, not types)", () => {
    const dts = readFileSync(
      fileURLToPath(new URL("../../core/dist/Aravis/index.d.ts", import.meta.url)),
      "utf8",
    );
    // The three sub-unions (PixelFormat8/16/12p) hold the literal names; slice
    // up to the aggregate alias (which references type names, not literals).
    const block = dts.slice(
      dts.indexOf("type PixelFormat8"),
      dts.indexOf("export type PixelFormat ="),
    );
    const unionNames = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    expect(unionNames).toEqual(new Set(PIXEL_FORMAT_NAMES));
  });
});
