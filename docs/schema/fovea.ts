export const FOVEA_EXTENSION = ".fovea";
export const FOVEA_PROFILE = "fovea";
export const FOVEA_LIBRARY = "FoveaCamApp";

export const TELEMETRY_TOPIC = "telemetry";
export const RAW_FRAME_SCHEMA_NAME = "fovea.raw_frame/v1";
export const TELEMETRY_SCHEMA_NAME = "fovea.frame_meta/v1";
export const JSON_SCHEMA_ENCODING = "jsonschema";
export const RAW_FRAME_MESSAGE_ENCODING = "x-fovea-raw";
export const TELEMETRY_MESSAGE_ENCODING = "json";

export const SESSION_METADATA_NAME = "fovea:session";
export const FINALIZE_METADATA_NAME = "fovea:finalize";

export const DEFAULT_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_MAX_QUEUED_FRAMES = 8;

export const RAW_FRAME_SCHEMA_DATA = JSON.stringify({
  description:
    "Raw frame bytes exactly as captured (12p formats stay packed). " +
    "Decode props are in the channel metadata.",
});

export const TELEMETRY_SCHEMA_DATA = JSON.stringify({
  description:
    "Per-frame JSON metadata document: {stream, seq, t, ...extras} — " +
    "extras are the legacy .meta sidecar's `x` payload (volt/angle/affine). " +
    "Correlate with the frame by stream+seq (or logTime).",
});

export const FRAME_METADATA_KEYS = [
  "dtype",
  "shape",
  "channels",
  "pixelFormat",
  "significantBits",
] as const;

