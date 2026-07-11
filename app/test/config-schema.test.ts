// Drift guard for the extracted config SCHEMA (@lib/config-schema) — the Vue-free
// single source of truth for the shared `["config"]` document's path, value
// unions, defaults, and clamp bounds. It exists so the four orchestrator readers
// (`@orchestrator/{prediction-rate,serial-latency,record-compression,
// anaglyph-style}`) can agree with the renderer `@lib/config` WITHOUT importing
// Vue. This test pins that the renderer defaults are built from the SAME schema
// constants the readers import, so the old "keep in sync" hand-mirroring can
// never silently drift back.

import { describe, expect, it, vi } from "vitest";
import {
  APP_CONFIG_PATH,
  DEFAULT_PREDICTION_RATE_HZ,
  DEFAULT_RECORD_COMPRESSION,
  DEFAULT_SERIAL_LATENCY_COMP,
  PREDICTION_RATE_MAX,
  PREDICTION_RATE_MIN,
  RECORD_COMPRESSIONS,
  coerceRecordCompression,
} from "@lib/config-schema";

// `@lib/config` pulls the renderer `Store` client, which touches `window` at
// load — stub it (same as anaglyph.test.ts); only the pure defaults are read.
vi.mock("@lib/store", () => ({ default: class {} }));
import {
  APP_CONFIG_DEFAULTS,
  APP_CONFIG_PATH as CONFIG_PATH_REEXPORT,
} from "@lib/config";

describe("config-schema ↔ @lib/config defaults", () => {
  it("declares the shared doc path once and re-exports it from @lib/config", () => {
    expect(APP_CONFIG_PATH).toEqual(["config"]);
    // `@lib/config` re-exports the SAME path (single definition).
    expect(CONFIG_PATH_REEXPORT).toBe(APP_CONFIG_PATH);
  });

  it("builds the renderer defaults from the schema constants (no drift)", () => {
    expect(APP_CONFIG_DEFAULTS.prediction_rate_hz).toBe(DEFAULT_PREDICTION_RATE_HZ);
    expect(APP_CONFIG_DEFAULTS.serial_latency_comp).toBe(DEFAULT_SERIAL_LATENCY_COMP);
    expect(APP_CONFIG_DEFAULTS.record_compression).toBe(DEFAULT_RECORD_COMPRESSION);
  });

  it("pins the ruled prediction-rate window and record-compression union", () => {
    expect(PREDICTION_RATE_MIN).toBe(60);
    expect(PREDICTION_RATE_MAX).toBe(1000);
    expect(DEFAULT_PREDICTION_RATE_HZ).toBe(600);
    expect(RECORD_COMPRESSIONS).toEqual(["none", "zlib"]);
    expect(DEFAULT_RECORD_COMPRESSION).toBe("none");
  });

  it("coerces untrusted record-compression values to the union", () => {
    expect(coerceRecordCompression("zlib")).toBe("zlib");
    expect(coerceRecordCompression("none")).toBe("none");
    expect(coerceRecordCompression("gzip")).toBe("none");
    expect(coerceRecordCompression(undefined)).toBe("none");
    expect(coerceRecordCompression(42)).toBe("none");
  });
});
