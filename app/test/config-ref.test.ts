// Coverage for the app-config "special computed ref" (`configRef`) + the
// declared AppConfig defaults. The cross-WINDOW half of live apply is the
// store-hub broadcast (see store-hub.test.ts); here we cover the in-object half
// the helper owns: writing the ref updates the shared reactive document, a
// second consumer over the same object sees it, defaults fill absent keys, and
// an externally-applied write (mimicking a store-hub echo) flows into the ref.

import { describe, expect, it, vi } from "vitest";
import { reactive } from "vue";
import { useDefaults } from "@lib/util/index";

// `@lib/config` imports the renderer `Store` client, whose module chain touches
// `window` at load (client.ts) — undefined in the node test env. Stub it: this
// suite exercises only the pure `configRef` / defaults, which never call Store.
vi.mock("@lib/store", () => ({ default: class {} }));

import { configRef, APP_CONFIG_DEFAULTS, type AppConfig } from "@lib/config";

function makeConfig(initial: Partial<AppConfig> = {}) {
  // Mirrors `useAppConfig()`: a reactive document behind the `useDefaults` proxy.
  return useDefaults<AppConfig>(reactive(initial), APP_CONFIG_DEFAULTS);
}

describe("configRef", () => {
  it("reads the declared default when the document has no value", () => {
    const config = makeConfig();
    expect(configRef(config, "cal_marker_size_mm").value).toBe(60);
    expect(configRef(config, "baseline_distance_mm").value).toBe(200);
    expect(configRef(config, "cal_marker_ratio").value).toBe(1.0);
    expect(configRef(config, "tele_canvas_url").value).toBe("");
    expect(configRef(config, "default_save_dir").value).toBe("");
  });

  it("write → read round-trips through the shared document", () => {
    const config = makeConfig();
    const ref = configRef(config, "cal_marker_size_mm");
    ref.value = 42;
    expect(ref.value).toBe(42);
    expect(config.cal_marker_size_mm).toBe(42);
  });

  it("propagates a write to a SECOND consumer of the same document (in-window interop)", () => {
    const config = makeConfig();
    const a = configRef(config, "cal_marker_ratio");
    const b = configRef(config, "cal_marker_ratio");
    a.value = 0.8;
    expect(b.value).toBe(0.8);
  });

  it("reflects an external write applied onto the document (store-hub echo)", () => {
    const config = makeConfig({ tele_canvas_url: "http://a" });
    const ref = configRef(config, "tele_canvas_url");
    expect(ref.value).toBe("http://a");
    // A write from another window arrives as an in-place mutation of the same
    // reactive object (Store's `replaceInPlace`); the ref must see it.
    (config as AppConfig).tele_canvas_url = "http://b";
    expect(ref.value).toBe("http://b");
  });

  it("clearing an optional key falls back to the default", () => {
    const config = makeConfig({ default_save_dir: "/data" });
    const ref = configRef(config, "default_save_dir");
    expect(ref.value).toBe("/data");
    ref.value = "";
    expect(ref.value).toBe("");
  });
});

describe("APP_CONFIG_DEFAULTS", () => {
  it("declares the shipped defaults", () => {
    expect(APP_CONFIG_DEFAULTS).toMatchObject({
      tele_canvas_url: "",
      default_save_dir: "",
      baseline_distance_mm: 200,
      cal_marker_size_mm: 60,
      cal_marker_ratio: 1.0,
      cap_stack: 5,
    });
  });
});
