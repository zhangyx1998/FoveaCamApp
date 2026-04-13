import type { TypedArray } from "core/types";

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
