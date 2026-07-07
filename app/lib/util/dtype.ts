import type { TypedArray } from "core/types";
import type { PixelFormat } from "core/Aravis";
import { pixelFormatSpec } from "../../../docs/schema/pixel-formats.js";

export type Dtype =
  | "U8"
  | "I8"
  | "U16"
  | "I16"
  | "U32"
  | "I32"
  | "F32"
  | "F64"
  | "U64"
  | "I64";

/** Resolve short dtype string from a Mat instance. */
export function dtypeOf(mat: TypedArray): Dtype {
  switch (true) {
    case mat instanceof Uint8Array:
    case mat instanceof Uint8ClampedArray:
      return "U8";
    case mat instanceof Int8Array:
      return "I8";
    case mat instanceof Uint16Array:
      return "U16";
    case mat instanceof Int16Array:
      return "I16";
    case mat instanceof Uint32Array:
      return "U32";
    case mat instanceof Int32Array:
      return "I32";
    case mat instanceof Float32Array:
      return "F32";
    case mat instanceof Float64Array:
      return "F64";
    case mat instanceof BigUint64Array:
      return "U64";
    case mat instanceof BigInt64Array:
      return "I64";
    default:
      throw new Error(
        `Unknown TypedArray type: ${(mat as any).constructor?.name}`,
      );
  }
}

/**
 * Effective bit depth of the pixel data. 12p formats carry 12 significant bits
 * in a 16-bit container, so consumers must scale by 4095 rather than 65535.
 * Moved here (from `src/record/stream.ts`) so it — and anything that imports
 * it, e.g. `lib/imgproc.ts`'s `stack()` — stays reachable from the
 * orchestrator, which must not pull in Vue (`src/record/stream.ts` imports
 * `FreqMeter` from `@lib/util/perf.ts`, a Vue-touching file).
 */
export function significantBits(format: PixelFormat): number {
  // Single source of truth: the pixel-format registry (docs/schema, B-P1) —
  // so this can't drift from the C++ tables / pyfovea decode. The suffix
  // heuristic survives only as a defensive fallback for names outside the
  // table; every real format is a table row and the C-P6 conformance test
  // pins that the table path equals the old heuristic for each one.
  const spec = pixelFormatSpec(format);
  if (spec) return spec.significantBits;
  if (format.endsWith("12p")) return 12;
  if (format.endsWith("16")) return 16;
  return 8;
}

/** Registry-backed dtype for a pixel format, with the recorded Mat dtype as
 *  fallback for unknown/legacy names outside the table. */
export function pixelFormatDtype(
  format: PixelFormat,
  fallback: Dtype = "U8",
): Dtype {
  return pixelFormatSpec(format)?.dtype ?? fallback;
}

/** Registry-backed channel count for a pixel format, with the Mat's actual
 *  channel count as fallback for unknown/legacy names outside the table. */
export function pixelFormatChannels(format: PixelFormat, fallback = 1): number {
  return pixelFormatSpec(format)?.channels ?? fallback;
}

/** TypedArray constructor keyed by short dtype name. */
export function typedArrayFrom(dtype: Dtype) {
  switch (dtype) {
    case "U8":
      return Uint8Array;
    case "I8":
      return Int8Array;
    case "U16":
      return Uint16Array;
    case "I16":
      return Int16Array;
    case "U32":
      return Uint32Array;
    case "I32":
      return Int32Array;
    case "F32":
      return Float32Array;
    case "F64":
      return Float64Array;
    case "U64":
      return BigUint64Array;
    case "I64":
      return BigInt64Array;
    default:
      throw new Error(`Unknown dtype: ${dtype}`);
  }
}
