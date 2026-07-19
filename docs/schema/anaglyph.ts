// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// SINGLE SOURCE OF TRUTH for the ANAGLYPH STYLE → channel mapping. Every
// surface that renders or composes an anaglyph derives its
// left/right channel routing from THIS table so they can never drift:
//   · the Settings cards (app/src/windows/ConfigBody.vue) — the swatches +
//     labels,
//   · the disparity-scope center-view label (app/modules/disparity-scope/
//     index.vue),
//   · the standalone viewer's 3D compose (app/src/windows/ViewerWindow.vue).
// The native CompositeStream brick (core/lib/Aravis/CompositeStream.{h,cpp})
// hand-mirrors `ANAGLYPH_CHANNELS` (a C++ enum + static table); the drift guard
// is the pinned core test `core/test/27-composite-pipe.ts` (RC default + BR
// swap), NOT a generated header — the table is four rows and near-static.
//
// A STYLE is written "<left>/<right>" = the LEFT-eye color / the RIGHT-eye
// color: R = red, B = blue, C = cyan (= green + blue). The four supported
// options are RB, RC (default — red-left / cyan-right), BR, and CR (the
// mirror of the classic R/C).
//
// The enum is deliberately trivial to extend/reorder: add a row to
// `ANAGLYPH_COLORS`, list it in `ANAGLYPH_STYLES`, regenerate nothing (the
// channel map + cards + labels all derive).

/** The four anaglyph styles: "<left-eye color><right-eye color>". */
export type AnaglyphStyle = "RB" | "RC" | "BR" | "CR";

/** Ordered option list (the Settings cards + any menus render in this order). */
export const ANAGLYPH_STYLES: readonly AnaglyphStyle[] = ["RB", "RC", "BR", "CR"];

/** Default = the historical behavior (red = LEFT eye, cyan = RIGHT eye) — the
 *  disparity-scope "Anaglyph (Red = Left, Cyan = Right)" convention + the
 *  viewer's red-left compose. Absent config / unknown value coerces to this. */
export const DEFAULT_ANAGLYPH_STYLE: AnaglyphStyle = "RC";

/** A per-eye anaglyph color. `cyan` occupies BOTH the green and blue channels. */
export type EyeColor = "red" | "blue" | "cyan";

export interface StyleColors {
  left: EyeColor;
  right: EyeColor;
}

/** The human concept each style encodes (left-eye color / right-eye color) —
 *  the channel routing below is DERIVED from this, so this is the one place a
 *  new/edited style is described. */
export const ANAGLYPH_COLORS: Record<AnaglyphStyle, StyleColors> = {
  RB: { left: "red", right: "blue" },
  RC: { left: "red", right: "cyan" },
  BR: { left: "blue", right: "red" },
  CR: { left: "cyan", right: "red" },
};

/** The output channels each color occupies (honest RGBA8: r = ch0, g = ch1,
 *  b = ch2). Cyan = green + blue. */
const COLOR_CHANNELS: Record<EyeColor, readonly ("r" | "g" | "b")[]> = {
  red: ["r"],
  blue: ["b"],
  cyan: ["g", "b"],
};

/** Which eye sources an output channel: `"left"` = the LEFT frame's SAME
 *  channel, `"right"` = the RIGHT frame's, `null` = forced 0 (alpha is always
 *  255, handled separately). */
export type ChannelSource = "left" | "right" | null;

export interface AnaglyphChannelMap {
  r: ChannelSource;
  g: ChannelSource;
  b: ChannelSource;
}

/**
 * Derive a style's channel routing under the CONFLICT RULE: the LEFT eye
 * claims its color's channels FIRST; the RIGHT eye then fills ONLY the
 * channels the left eye did not claim — "the later-listed eye never silently
 * overwrites." None of the four styles conflict (each pairs a primary
 * with its complement or the other primary), but the rule is load-bearing for
 * any future style whose eyes share a channel: the resolved map — not the
 * nominal eye colors — is what the compose paints, the swatch shows, and the
 * label names (see resolvedSideCss/anaglyphEyeLabel).
 */
export function channelMapFor(style: AnaglyphStyle): AnaglyphChannelMap {
  const { left, right } = ANAGLYPH_COLORS[style];
  const map: AnaglyphChannelMap = { r: null, g: null, b: null };
  for (const ch of COLOR_CHANNELS[left]) map[ch] = "left"; // left claims first
  for (const ch of COLOR_CHANNELS[right]) if (map[ch] === null) map[ch] = "right"; // right fills free
  return map;
}

/** The derived style → channel-source table (r = ch0, g = ch1, b = ch2). The
 *  canonical routing every surface reads; the native brick mirrors it. */
export const ANAGLYPH_CHANNELS: Record<AnaglyphStyle, AnaglyphChannelMap> =
  Object.fromEntries(ANAGLYPH_STYLES.map((s) => [s, channelMapFor(s)])) as Record<
    AnaglyphStyle,
    AnaglyphChannelMap
  >;

/** LITERAL display colors for the eye-color swatches — CONTENT, not palette
 *  tokens (an anaglyph's red/blue/cyan are the thing itself, not a themeable UI
 *  accent). Slightly desaturated so the white "L"/"R" glyphs stay legible. */
export const EYE_COLOR_CSS: Record<EyeColor, string> = {
  red: "rgb(214, 48, 49)",
  blue: "rgb(52, 73, 214)",
  cyan: "rgb(40, 190, 200)",
};

/** LITERAL display color for a RESOLVED channel set — the channels ONE eye
 *  actually drives after the conflict rule, keyed by the active channels in
 *  r,g,b order. CONTENT, not palette tokens (same rationale as EYE_COLOR_CSS).
 *  A swatch half must show the TRUTH the compose produces: a conflicted eye
 *  (cyan) keeps only GREEN once the left (blue) eye takes the shared blue
 *  channel — so its right half is green, never the nominal cyan. The single-/
 *  paired-channel entries reuse the eye-color literals so RB/RC/BR are byte-
 *  identical to the nominal colors; the "g"-alone case is unused by the four
 *  styles but stays for any future style that shares a channel. */
const CHANNEL_SET_CSS: Record<string, string> = {
  r: EYE_COLOR_CSS.red, // red alone
  g: "rgb(46, 174, 92)", // green alone — a cyan eye whose blue channel was claimed
  b: EYE_COLOR_CSS.blue, // blue alone
  gb: EYE_COLOR_CSS.cyan, // green + blue = cyan
};

/** The literal swatch color for one eye's RESOLVED half — derived from the
 *  style's channel map (not the nominal eye color) so the card always shows
 *  what the compose actually paints. The LEFT eye always keeps its full color
 *  (it claims channels first); only the later-listed eye can be reduced. */
export function resolvedSideCss(style: AnaglyphStyle, side: "left" | "right"): string {
  const map = ANAGLYPH_CHANNELS[style];
  const key = (["r", "g", "b"] as const).filter((ch) => map[ch] === side).join("");
  return CHANNEL_SET_CSS[key] ?? "rgb(0, 0, 0)"; // no channels → black (unused)
}

/** Short badge for a style, e.g. "R/C". */
export function anaglyphSlashLabel(style: AnaglyphStyle): string {
  return `${style[0]}/${style[1]}`;
}

/** Name of a RESOLVED channel set (mirrors CHANNEL_SET_CSS keys). */
const CHANNEL_SET_NAME: Record<string, string> = {
  r: "Red",
  g: "Green", // a cyan eye reduced to green (blue channel claimed by the other)
  b: "Blue",
  gb: "Cyan",
};

/** Long descriptive label, e.g. "Red = Left, Cyan = Right" — the disparity-
 *  scope center-view option text, following the configured style. Named
 *  from the RESOLVED channels, not the nominal eye colors, so a conflicted
 *  style truthfully names the reduced color — matching the swatch and what
 *  the compose actually paints. */
export function anaglyphEyeLabel(style: AnaglyphStyle): string {
  const map = ANAGLYPH_CHANNELS[style];
  const name = (side: "left" | "right") =>
    CHANNEL_SET_NAME[
      (["r", "g", "b"] as const).filter((ch) => map[ch] === side).join("")
    ] ?? "None";
  return `${name("left")} = Left, ${name("right")} = Right`;
}

/** One Settings card's view-model: the slash label, per-half swatch color, and
 *  whether it is the currently-selected style. Pure so the card renderer + its
 *  vitest coverage share the exact selection/label logic (surfaces can't
 *  drift). */
export interface AnaglyphCard {
  style: AnaglyphStyle;
  label: string;
  leftColor: EyeColor;
  rightColor: EyeColor;
  leftCss: string;
  rightCss: string;
  selected: boolean;
}

/** Build the ordered card list, marking `selected` as the currently-chosen
 *  style (coerced to the default when the passed value is unknown/absent). */
export function anaglyphCards(selected: string | null | undefined): AnaglyphCard[] {
  const active = coerceAnaglyphStyle(selected);
  return ANAGLYPH_STYLES.map((style) => {
    const { left, right } = ANAGLYPH_COLORS[style];
    return {
      style,
      label: anaglyphSlashLabel(style),
      leftColor: left,
      rightColor: right,
      // Swatch halves derive from the RESOLVED channels, not the nominal eye
      // color — the exact result the compose paints (identical for the four
      // styles; differs only if a future style's eyes share a channel).
      leftCss: resolvedSideCss(style, "left"),
      rightCss: resolvedSideCss(style, "right"),
      selected: style === active,
    };
  });
}

/** Coerce an untrusted value (config read, wire) to a valid style, falling back
 *  to {@link DEFAULT_ANAGLYPH_STYLE}. Shared by every reader so validation is
 *  identical across processes. */
export function coerceAnaglyphStyle(value: unknown): AnaglyphStyle {
  return typeof value === "string" &&
    (ANAGLYPH_STYLES as readonly string[]).includes(value)
    ? (value as AnaglyphStyle)
    : DEFAULT_ANAGLYPH_STYLE;
}
