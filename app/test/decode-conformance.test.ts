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
import { describe, expect, it, vi } from "vitest";
import {
  PIXEL_FORMATS,
  PIXEL_FORMAT_NAMES,
  cvBayerPrefix,
  pixelFormatSpec,
} from "../../docs/schema/pixel-formats.js";
import {
  pixelFormatChannels,
  pixelFormatDtype,
  significantBits,
} from "@lib/util/dtype";
import { bayerCode, parseDecodeProps } from "@src/viewer/decode";

describe("decode conformance vs docs/schema/pixel-formats (C-P6)", () => {
  it("dtype.significantBits matches the schema for every format", () => {
    for (const name of PIXEL_FORMAT_NAMES) {
      const spec = pixelFormatSpec(name)!;
      expect(significantBits(name as never)).toBe(spec.significantBits);
    }
  });

  it("dtype pixel-format helpers match the schema for every known format", () => {
    for (const spec of PIXEL_FORMATS) {
      expect(pixelFormatDtype(spec.name as never, "U8")).toBe(spec.dtype);
      expect(pixelFormatChannels(spec.name as never, -1)).toBe(spec.channels);
    }
  });

  it("decode.bayerCode applies the OpenCV↔PFNC R/B-swap for every format", () => {
    for (const spec of PIXEL_FORMATS) {
      // The demosaic constant carries the off-by-one correction: a GenICam
      // BayerRG mosaic decodes with COLOR_BayerBG2RGB (channel-order-fix.md).
      const expected = spec.bayer ? `${cvBayerPrefix(spec.bayer)}2RGB` : null;
      expect(bayerCode(spec.name)).toBe(expected);
    }
  });

  it("bayerCode picks the R/B-swapped OpenCV prefix, not the literal PFNC name", () => {
    // Pin the actual correction so a regression back to the literal name fails.
    expect(bayerCode("BayerRG8")).toBe("BayerBG2RGB");
    expect(bayerCode("BayerBG12p")).toBe("BayerRG2RGB");
    expect(bayerCode("BayerGR16")).toBe("BayerGB2RGB");
    expect(bayerCode("BayerGB8")).toBe("BayerGR2RGB");
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

  it("core/Aravis PixelFormat d.ts sub-unions match schema partitions", () => {
    const dts = readFileSync(
      fileURLToPath(new URL("../../core/dist/Aravis/index.d.ts", import.meta.url)),
      "utf8",
    );
    const union = (name: string) => {
      const match = dts.match(new RegExp(`type ${name} =([\\s\\S]*?);`));
      expect(match).toBeTruthy();
      return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    expect(union("PixelFormat8")).toEqual(
      PIXEL_FORMATS.filter((f) => f.significantBits === 8).map((f) => f.name),
    );
    expect(union("PixelFormat16")).toEqual(
      PIXEL_FORMATS.filter((f) => f.significantBits === 16).map((f) => f.name),
    );
    expect(union("PixelFormat12p")).toEqual(
      PIXEL_FORMATS.filter((f) => f.isPacked).map((f) => f.name),
    );
  });

  it("parseDecodeProps warns, but does not reject, recorded metadata that drifts from schema", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = parseDecodeProps({
      dtype: "U16",
      shape: "[2,2]",
      channels: "1",
      pixelFormat: "Mono8",
      significantBits: "16",
    });
    expect(props).toMatchObject({
      dtype: "U16",
      channels: 1,
      pixelFormat: "Mono8",
      significantBits: 16,
    });
    expect(warn).toHaveBeenCalledWith(
      "[viewer] recording metadata differs from pixel-format schema",
      expect.objectContaining({ pixelFormat: "Mono8" }),
    );
    warn.mockRestore();
  });
});
