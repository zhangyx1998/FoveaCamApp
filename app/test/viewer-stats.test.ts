// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Pure stream-stats assembly + formatting + popover clamp math for the
// right-click stats popover (src/viewer/stats.ts). No Vue / Node / core.

import { describe, expect, it } from "vitest";
import {
  assembleStaticStats,
  clampPopover,
  computeAvgFps,
  formatDuration,
  formatFps,
  formatPixelFormat,
  formatResolution,
  splitBaseCodecs,
} from "@src/viewer/stats";
import type { ViewerChannelInfo } from "@src/viewer/protocol";

const NS = 1e9;

describe("splitBaseCodecs", () => {
  it("splits the base format from its codec suffix chain", () => {
    expect(splitBaseCodecs("BayerRG12p/zlib")).toEqual({ base: "BayerRG12p", codecs: ["zlib"] });
    expect(splitBaseCodecs("Mono8")).toEqual({ base: "Mono8", codecs: [] });
    expect(splitBaseCodecs("Mono12p/a/b")).toEqual({ base: "Mono12p", codecs: ["a", "b"] });
  });
});

describe("computeAvgFps", () => {
  it("uses (count-1) intervals over the span — 6 frames @ 0.5 s → 10 fps", () => {
    expect(computeAvgFps(6, 0.5 * NS)).toBeCloseTo(10, 6);
  });
  it("returns null when it can't be computed", () => {
    expect(computeAvgFps(1, NS)).toBeNull(); // < 2 messages
    expect(computeAvgFps(10, 0)).toBeNull(); // zero span
    expect(computeAvgFps(null, NS)).toBeNull(); // no count
  });
});

describe("assembleStaticStats", () => {
  const info: ViewerChannelInfo = {
    name: "left-cam",
    metadata: {
      dtype: "U16",
      shape: "[720, 1280]",
      channels: "1",
      pixelFormat: "BayerRG12p/zlib",
      significantBits: "12",
      messageEncoding: "x-fovea-raw",
    },
    startNs: 100 * 1e6, // 0.1 s
    lastNs: 600 * 1e6, // 0.6 s
    messageCount: 6,
  };

  it("derives format / codec / resolution / span / avg fps from channel info", () => {
    const s = assembleStaticStats(info);
    expect(s.name).toBe("left-cam");
    expect(s.pixelFormat).toBe("BayerRG12p");
    expect(s.codec).toBe("zlib");
    expect(s.significantBits).toBe(12);
    expect(s.width).toBe(1280);
    expect(s.height).toBe(720);
    expect(s.channels).toBe(1);
    expect(s.messageCount).toBe(6);
    expect(s.spanNs).toBe(0.5 * NS);
    expect(s.avgFps).toBeCloseTo(10, 6);
  });

  it("tolerates missing/malformed metadata without throwing", () => {
    const bare: ViewerChannelInfo = { name: "x", metadata: { messageEncoding: "json" } };
    const s = assembleStaticStats(bare);
    expect(s.name).toBe("x");
    expect(s.pixelFormat).toBe("");
    expect(s.codec).toBeNull();
    expect(s.width).toBe(0);
    expect(s.messageCount).toBeNull();
    expect(s.avgFps).toBeNull();
  });
});

describe("formatters", () => {
  it("formatDuration: seconds under 100 s, M:SS above", () => {
    expect(formatDuration(12.34 * NS)).toBe("12.3 s");
    expect(formatDuration(0)).toBe("0.0 s");
    expect(formatDuration(-5)).toBe("0.0 s");
    expect(formatDuration(125 * NS)).toBe("2:05");
  });
  it("formatFps: two decimals + unit, dash when absent", () => {
    expect(formatFps(29.97)).toBe("29.97 fps");
    expect(formatFps(null)).toBe("—");
    expect(formatFps(Infinity)).toBe("—");
  });
  it("formatResolution: WxH, dash when unknown", () => {
    expect(formatResolution(1280, 720)).toBe("1280 × 720");
    expect(formatResolution(0, 0)).toBe("—");
  });
  it("formatPixelFormat: 'Base · N-bit · /codec'", () => {
    expect(
      formatPixelFormat({
        name: "c", pixelFormat: "BayerRG12p", significantBits: 12, codec: "zlib",
        width: 1, height: 1, channels: 1, messageCount: 1, spanNs: 1, avgFps: null,
      }),
    ).toBe("BayerRG12p · 12-bit · /zlib");
    expect(
      formatPixelFormat({
        name: "c", pixelFormat: "Mono8", significantBits: 8, codec: null,
        width: 1, height: 1, channels: 1, messageCount: 1, spanNs: 1, avgFps: null,
      }),
    ).toBe("Mono8 · 8-bit");
  });
});

describe("clampPopover", () => {
  it("keeps the anchor when it fits", () => {
    expect(clampPopover(100, 100, 280, 200, 1000, 800)).toEqual({ x: 100, y: 100 });
  });
  it("shifts left/up so the box stays fully inside with the margin", () => {
    // Anchor near the bottom-right edge → clamps to winW/H - w/h - margin.
    expect(clampPopover(950, 750, 280, 200, 1000, 800, 8)).toEqual({ x: 712, y: 592 });
  });
  it("never pushes past the top-left margin on a tiny viewport", () => {
    expect(clampPopover(0, 0, 280, 200, 100, 100, 8)).toEqual({ x: 8, y: 8 });
  });
});
