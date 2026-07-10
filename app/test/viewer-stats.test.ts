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
  assembleEntityDetail,
  assembleStaticStats,
  clampPopover,
  computeAvgFps,
  formatDuration,
  formatFps,
  formatPixelFormat,
  formatResolution,
  formatTimecode,
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

describe("formatTimecode (HH:MM:SS.sss, UI round 2 ruling 3)", () => {
  it("zero-pads all fields", () => {
    expect(formatTimecode(0)).toBe("00:00:00.000");
    expect(formatTimecode(1.5 * NS)).toBe("00:00:01.500");
    expect(formatTimecode(65.123 * NS)).toBe("00:01:05.123");
  });
  it("shows hours past one hour (and beyond)", () => {
    expect(formatTimecode(3661.007 * NS)).toBe("01:01:01.007"); // 1h 1m 1.007s
    expect(formatTimecode(36_000 * NS)).toBe("10:00:00.000"); // 10 h
  });
  it("rounds to the nearest millisecond and never goes negative", () => {
    expect(formatTimecode(1_499_600)).toBe("00:00:00.001"); // 1.4996 ms → 1 ms
    expect(formatTimecode(1_500_000)).toBe("00:00:00.002"); // 1.5 ms → 2 ms
    expect(formatTimecode(-5)).toBe("00:00:00.000");
  });
});

describe("assembleEntityDetail (property panel, UI round 2 ruling 4)", () => {
  const info: ViewerChannelInfo = {
    name: "left-cam",
    metadata: {
      shape: "[720, 1280]",
      channels: "1",
      pixelFormat: "BayerRG12p/zlib",
      significantBits: "12",
      messageEncoding: "x-fovea-raw",
    },
    startNs: 100 * 1e6, // 0.1 s file-relative
    lastNs: 600 * 1e6, // 0.6 s
    messageCount: 6,
  };

  it("reuses the static stats and folds in topology + timestamps", () => {
    const startEpochMs = 1_700_000_000_000; // recording start (epoch ms)
    const d = assembleEntityDetail(info, {
      startEpochMs,
      track: 2,
      isMaster: false,
      side: "left",
      pairBase: "cam",
      enabled: true,
    });
    // reused static half
    expect(d.stat.pixelFormat).toBe("BayerRG12p");
    expect(d.stat.significantBits).toBe(12);
    expect(d.stat.avgFps).toBeCloseTo(10, 6);
    // added context
    expect(d.name).toBe("left-cam");
    expect(d.encoding).toBe("x-fovea-raw");
    expect(d.firstNs).toBe(100 * 1e6);
    expect(d.lastNs).toBe(600 * 1e6);
    expect(d.firstEpochMs).toBe(startEpochMs + 100); // +0.1 s = +100 ms
    expect(d.lastEpochMs).toBe(startEpochMs + 600);
    expect(d.spanNs).toBe(0.5 * NS);
    expect(d.track).toBe(2);
    expect(d.isMaster).toBe(false);
    expect(d.side).toBe("left");
    expect(d.pairBase).toBe("cam");
    expect(d.enabled).toBe(true);
  });

  it("leaves epoch null when the file's start epoch is unknown", () => {
    const d = assembleEntityDetail(info, {
      startEpochMs: null,
      track: null,
      isMaster: false,
      side: null,
      pairBase: null,
      enabled: false,
    });
    expect(d.firstEpochMs).toBeNull();
    expect(d.lastEpochMs).toBeNull();
    expect(d.track).toBeNull();
    expect(d.side).toBeNull();
    expect(d.pairBase).toBeNull();
    expect(d.enabled).toBe(false);
  });

  it("tolerates a channel with no span (null first/last)", () => {
    const bare: ViewerChannelInfo = { name: "x", metadata: { messageEncoding: "json" } };
    const d = assembleEntityDetail(bare, {
      startEpochMs: 1_000,
      track: 0,
      isMaster: true,
      side: null,
      pairBase: null,
      enabled: true,
    });
    expect(d.firstNs).toBeNull();
    expect(d.lastNs).toBeNull();
    expect(d.firstEpochMs).toBeNull();
    expect(d.encoding).toBe("json");
    expect(d.isMaster).toBe(true);
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
