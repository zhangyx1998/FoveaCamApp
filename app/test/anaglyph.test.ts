// Coverage for the SHARED anaglyph style → channel mapping (docs/schema/
// anaglyph.ts) — the single source of truth every surface reads: the Settings
// cards, the disparity-scope label, the viewer 3D compose, and (mirrored) the
// native CompositeStream brick. Pins the derived channel table (incl. the B/C
// conflict resolution), the card selection/label model, coercion, and the
// declared config default RC.

import { describe, expect, it, vi } from "vitest";
import {
  ANAGLYPH_CHANNELS,
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
    expect(ANAGLYPH_STYLES).toEqual(["RB", "RC", "BR", "BC"]);
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
      // B/C (VERBATIM, odd): left blue keeps B; right cyan would want G+B but B
      // is taken → right keeps only G; red unused. Documents the conflict rule.
      BC: { r: null, g: "right", b: "left" },
    };
    expect(ANAGLYPH_CHANNELS).toEqual(expected);
    // And the derivation function agrees for every style.
    for (const s of ANAGLYPH_STYLES) expect(channelMapFor(s)).toEqual(expected[s]);
  });

  it("B/C shares the blue channel with the LEFT eye, never overwritten by right", () => {
    const bc = ANAGLYPH_CHANNELS.BC;
    expect(bc.b).toBe("left"); // left blue wins ch2
    expect(bc.g).toBe("right"); // right cyan keeps only ch1
    expect(bc.r).toBeNull(); // red unused
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
    // B/C: right eye's cyan loses the shared blue channel to the left eye —
    // the render is green, and the label must say so (matches the swatch).
    expect(anaglyphEyeLabel("BC")).toBe("Blue = Left, Green = Right");
  });
});

describe("anaglyphCards", () => {
  it("builds one card per style, in order, with literal swatch colors", () => {
    const cards = anaglyphCards("RC");
    expect(cards.map((c) => c.style)).toEqual(["RB", "RC", "BR", "BC"]);
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
