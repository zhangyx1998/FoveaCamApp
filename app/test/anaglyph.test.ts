// Coverage for the SHARED anaglyph style → channel mapping (docs/schema/
// anaglyph.ts) — the single source of truth every surface reads: the Settings
// cards, the disparity-scope label, the viewer 3D compose, and (mirrored) the
// native CompositeStream brick. Pins the derived channel table (incl. the
// conflict resolution), the card selection/label model, coercion, and the
// declared config default RC.

import { describe, expect, it, vi } from "vitest";
import {
  ANAGLYPH_CHANNELS,
  ANAGLYPH_COLORS,
  ANAGLYPH_STYLES,
  DEFAULT_ANAGLYPH_STYLE,
  EYE_COLOR_CSS,
  anaglyphCards,
  anaglyphEyeLabel,
  anaglyphSlashLabel,
  channelMapFor,
  coerceAnaglyphStyle,
  type AnaglyphChannelMap,
} from "../../docs/schema/anaglyph";

// `@lib/config` pulls the renderer `Store` client, which touches `window` at
// load — stub it (same as config-ref.test.ts); only the pure defaults are read.
vi.mock("@lib/store", () => ({ default: class {} }));

describe("anaglyph style table", () => {
  it("declares the four ruled styles with RC default", () => {
    expect(ANAGLYPH_STYLES).toEqual(["RB", "RC", "BR", "CR"]);
    expect(DEFAULT_ANAGLYPH_STYLE).toBe("RC");
  });

  it("maps each style to the correct per-channel source (r=ch0,g=ch1,b=ch2)", () => {
    // The canonical table. LEFT claims its color's channels first; RIGHT fills
    // only what's free (later-listed eye never overwrites).
    const expected: Record<string, AnaglyphChannelMap> = {
      // R/B: left red → R, right blue → B, green unused.
      RB: { r: "left", g: null, b: "right" },
      // R/C (default): left red → R, right cyan → G+B. Matches the historical
      // red-left / cyan-right behavior.
      RC: { r: "left", g: "right", b: "right" },
      // B/R: left blue → B, right red → R, green unused.
      BR: { r: "right", g: null, b: "left" },
      // C/R (ruled 2026-07-10, mirror of R/C): left cyan → G+B, right red → R.
      CR: { r: "right", g: "left", b: "left" },
    };
    expect(ANAGLYPH_CHANNELS).toEqual(expected);
    // And the derivation function agrees for every style.
    for (const s of ANAGLYPH_STYLES) expect(channelMapFor(s)).toEqual(expected[s]);
  });

  it("conflict rule: a shared channel goes to the LEFT eye, right keeps the rest", () => {
    // No RULED style conflicts (C/R replaced the odd B/C, ruling 2026-07-10),
    // but the derivation rule guards future styles — pin it with a synthetic
    // blue/cyan row: they share ch2 → left wins, right reduces to green (ch1).
    (ANAGLYPH_COLORS as Record<string, unknown>)["XX"] = { left: "blue", right: "cyan" };
    try {
      expect(channelMapFor("XX" as never)).toEqual({ r: null, g: "right", b: "left" });
    } finally {
      delete (ANAGLYPH_COLORS as Record<string, unknown>)["XX"];
    }
  });
});

describe("coerceAnaglyphStyle", () => {
  it("passes valid styles through", () => {
    for (const s of ANAGLYPH_STYLES) expect(coerceAnaglyphStyle(s)).toBe(s);
  });
  it("falls back to RC on unknown / absent values", () => {
    expect(coerceAnaglyphStyle("XX")).toBe("RC");
    expect(coerceAnaglyphStyle(undefined)).toBe("RC");
    expect(coerceAnaglyphStyle(null)).toBe("RC");
    expect(coerceAnaglyphStyle(7)).toBe("RC");
  });
});

describe("labels", () => {
  it("slash label is <left>/<right>", () => {
    expect(anaglyphSlashLabel("RC")).toBe("R/C");
    expect(anaglyphSlashLabel("BR")).toBe("B/R");
  });
  it("eye label names the RESOLVED colors (copy honesty), not nominal", () => {
    expect(anaglyphEyeLabel("RC")).toBe("Red = Left, Cyan = Right");
    expect(anaglyphEyeLabel("BR")).toBe("Blue = Left, Red = Right");
    expect(anaglyphEyeLabel("CR")).toBe("Cyan = Left, Red = Right");
  });
});

describe("anaglyphCards", () => {
  it("builds one card per style, in order, with literal swatch colors", () => {
    const cards = anaglyphCards("RC");
    expect(cards.map((c) => c.style)).toEqual(["RB", "RC", "BR", "CR"]);
    const rc = cards.find((c) => c.style === "RC")!;
    expect(rc.label).toBe("R/C");
    expect(rc.leftColor).toBe("red");
    expect(rc.rightColor).toBe("cyan");
    expect(rc.leftCss).toBe(EYE_COLOR_CSS.red);
    expect(rc.rightCss).toBe(EYE_COLOR_CSS.cyan);
  });

  it("marks exactly the selected style", () => {
    const cards = anaglyphCards("BR");
    expect(cards.filter((c) => c.selected).map((c) => c.style)).toEqual(["BR"]);
  });

  it("coerces an unknown/absent selection to the default", () => {
    for (const sel of ["XX", undefined, null] as const) {
      const cards = anaglyphCards(sel);
      expect(cards.filter((c) => c.selected).map((c) => c.style)).toEqual([
        DEFAULT_ANAGLYPH_STYLE,
      ]);
    }
  });
});

describe("app config default", () => {
  it("declares anaglyph_style = RC", async () => {
    const { APP_CONFIG_DEFAULTS } = await import("@lib/config");
    expect(APP_CONFIG_DEFAULTS.anaglyph_style).toBe("RC");
  });
});
