// Unit coverage for the viewer VIDEO-EXPORT pure modules (viewer-export.md).
// Everything here is Electron-free + ffmpeg-free: the codec/pixfmt/alpha table,
// fps median (drop-robust) + blend math, the queue state machine (serial vs
// parallel, abort transitions), the undistort remap map math (known matrix →
// spot-checked coordinates), the banner episode state machine, ffmpeg
// discovery, the ffmpeg argv builder, and rgba normalization.

import { describe, expect, it } from "vitest";
import {
  CODECS,
  codec,
  pixfmtsFor,
  defaultPixfmtFor,
  alphaSupported,
  containerFor,
  defaultExportBasename,
} from "@src/viewer/export/codecs";
import { detectFps, uniformTimeline, blendWeights, blendFrames } from "@src/viewer/export/fps";
import { ExportQueue } from "@src/viewer/export/queue";
import {
  parseWideCalibration,
  buildRemapMaps,
  toPgm16,
  REMAP_FILL,
} from "@src/viewer/export/undistort";
import {
  initialBannerState,
  setActive,
  dismiss,
  bannerVisible,
} from "@src/viewer/export/banner";
import { resolveFfmpegPath, COMMON_FFMPEG_PATHS } from "@src/viewer/export/ffmpeg-detect";
import { buildFfmpegArgs } from "@src/viewer/export/ffmpeg-args";
import { toRGBA } from "@src/viewer/export/normalize";
import type { ExportRequest } from "@src/viewer/export/types";

function req(over: Partial<ExportRequest> = {}): ExportRequest {
  return {
    channel: "camera/A/raw",
    codec: "x264",
    pixfmt: "yuv420p",
    fps: 30,
    normalize: "as-is",
    undistort: false,
    alpha: false,
    outputPath: "/tmp/out.mp4",
    ...over,
  };
}

// ---- codec / pixfmt / alpha table ----------------------------------------

describe("codec table", () => {
  it("offers every ruled codec with a sane container", () => {
    expect(CODECS.map((c) => c.id)).toEqual(["prores", "x264", "x265", "vp9", "av1"]);
    expect(containerFor("prores")).toBe("mov");
    expect(containerFor("x264")).toBe("mp4");
    expect(containerFor("x265")).toBe("mp4");
    expect(containerFor("vp9")).toBe("webm");
    expect(containerFor("av1")).toBe("webm");
  });

  it("filters ProRes pixfmts by profile (4444 = alpha 4:4:4)", () => {
    expect(pixfmtsFor("prores", "422").map((p) => p.id)).toEqual(["yuv422p10le"]);
    expect(pixfmtsFor("prores", "422hq").map((p) => p.id)).toEqual(["yuv422p10le"]);
    expect(pixfmtsFor("prores", "4444").map((p) => p.id)).toEqual(["yuva444p10le"]);
    expect(defaultPixfmtFor("prores", "4444")).toBe("yuva444p10le");
  });

  it("models alpha capability per codec+pixfmt", () => {
    expect(alphaSupported("prores", "yuva444p10le")).toBe(true);
    expect(alphaSupported("prores", "yuv422p10le")).toBe(false);
    expect(alphaSupported("vp9", "yuva420p")).toBe(true);
    expect(alphaSupported("vp9", "yuv420p")).toBe(false);
    expect(alphaSupported("x264", "yuv444p")).toBe(false);
    expect(alphaSupported("av1", "yuv420p")).toBe(false); // AV1: never alpha
  });

  it("x265 adds 10-bit; x264 does not", () => {
    expect(codec("x265").pixfmts.some((p) => p.bits === 10)).toBe(true);
    expect(codec("x264").pixfmts.some((p) => p.bits === 10)).toBe(false);
  });

  it("builds a filesystem-safe default basename", () => {
    expect(defaultExportBasename("rec 2026", "camera/A/raw")).toBe("rec_2026-camera_A_raw");
  });
});

// ---- fps detection (median, drop-robust) ---------------------------------

describe("detectFps", () => {
  it("is the median interval → survives a few dropped frames", () => {
    // 30fps = 33.333ms = 33_333_333ns intervals, with two long gaps (drops).
    const dt = 33_333_333;
    const ts = [0, dt, 2 * dt, 2 * dt + 5 * dt /* drop */, 2 * dt + 6 * dt, 2 * dt + 7 * dt];
    expect(detectFps(ts)).toBeCloseTo(30, 1);
  });
  it("returns 0 for < 2 usable intervals", () => {
    expect(detectFps([])).toBe(0);
    expect(detectFps([42])).toBe(0);
    expect(detectFps([7, 7, 7])).toBe(0); // all-zero deltas
  });
});

describe("uniformTimeline", () => {
  it("evenly samples the span at fps, inclusive of the last grid ≤ end", () => {
    const t = uniformTimeline(0, 1e9, 4); // 4fps over 1s → 0,.25,.5,.75,1.0
    expect(t.length).toBe(5);
    expect(t[0]).toBe(0);
    expect(t[4]).toBeCloseTo(1e9, 0);
  });
  it("yields the start alone for a zero span", () => {
    expect(uniformTimeline(5, 5, 30)).toEqual([5]);
  });
});

// ---- blend weights + frame blend -----------------------------------------

describe("blendWeights", () => {
  it("is linear by temporal distance", () => {
    expect(blendWeights(25, 0, 100)).toEqual({ prev: 0.75, next: 0.25 });
    expect(blendWeights(0, 0, 100)).toEqual({ prev: 1, next: 0 });
    expect(blendWeights(100, 0, 100)).toEqual({ prev: 0, next: 1 });
  });
  it("clamps a degenerate/zero span onto prev", () => {
    expect(blendWeights(50, 100, 100)).toEqual({ prev: 1, next: 0 });
  });
});

describe("blendFrames", () => {
  it("interpolates two buffers, copying verbatim on a zero weight", () => {
    const a = new Uint8Array([0, 0, 0, 0]);
    const b = new Uint8Array([100, 200, 40, 255]);
    expect([...blendFrames(a, b, 0.5, 0.5)]).toEqual([50, 100, 20, 128]);
    expect([...blendFrames(a, b, 1, 0)]).toEqual([0, 0, 0, 0]); // copy prev
    expect([...blendFrames(a, b, 0, 1)]).toEqual([100, 200, 40, 255]); // copy next
  });
});

// ---- queue state machine (serial vs parallel, abort) ---------------------

describe("ExportQueue", () => {
  it("serial: one running at a time; completion advances the backlog", () => {
    const q = new ExportQueue(false);
    const a = q.enqueue(req());
    expect(a.start).toEqual([a.id]); // first dispatches immediately
    const b = q.enqueue(req());
    expect(b.start).toEqual([]); // queued behind a
    expect(q.activeCount()).toBe(2);
    const next = q.complete(a.id, true);
    expect(next).toEqual([b.id]); // a done → b starts
    expect(q.activeCount()).toBe(1);
    q.complete(b.id, true);
    expect(q.activeCount()).toBe(0);
    const states = q.snapshot().map((j) => j.state);
    expect(states).toEqual(["done", "done"]);
  });

  it("parallel: every queued job starts at once", () => {
    const q = new ExportQueue(true);
    const a = q.enqueue(req());
    const b = q.enqueue(req());
    expect(a.start).toEqual([a.id]);
    expect(b.start).toEqual([b.id]);
  });

  it("flipping parallel ON dispatches the serial backlog", () => {
    const q = new ExportQueue(false);
    q.enqueue(req());
    const b = q.enqueue(req());
    const c = q.enqueue(req());
    expect(b.start).toEqual([]);
    const started = q.setParallel(true);
    expect(new Set(started)).toEqual(new Set([b.id, c.id]));
  });

  it("aborts a running job (kill signal) and advances serial backlog", () => {
    const q = new ExportQueue(false);
    const a = q.enqueue(req());
    const b = q.enqueue(req());
    const r = q.abort(a.id);
    expect(r).toMatchObject({ aborted: true, wasRunning: true });
    expect(r.start).toEqual([b.id]); // abort frees the serial slot
    expect(q.snapshot()[0]!.state).toBe("aborted");
  });

  it("aborts a queued job without ever starting it (no kill)", () => {
    const q = new ExportQueue(false);
    q.enqueue(req());
    const b = q.enqueue(req());
    const r = q.abort(b.id);
    expect(r).toMatchObject({ aborted: true, wasRunning: false, start: [] });
  });

  it("clearFinished drops terminal jobs only (tray 'Clear finished')", () => {
    const q = new ExportQueue(true);
    const a = q.enqueue(req());
    const b = q.enqueue(req());
    const c = q.enqueue(req());
    q.complete(a.id, true); // done
    q.complete(b.id, false, "boom"); // failed
    q.clearFinished();
    // Only the running job survives; terminal rows are gone from the snapshot.
    expect(q.snapshot().map((j) => j.id)).toEqual([c.id]);
    expect(q.activeCount()).toBe(1);
    q.clearFinished(); // no-op with nothing terminal
    expect(q.snapshot().length).toBe(1);
  });

  it("abortAll reports the running ids for kill+unlink (spec 11)", () => {
    const q = new ExportQueue(true);
    const a = q.enqueue(req());
    const b = q.enqueue(req());
    const running = q.abortAll();
    expect(new Set(running)).toEqual(new Set([a.id, b.id]));
    expect(q.activeCount()).toBe(0);
  });

  it("overall progress averages queued(0)+running", () => {
    const q = new ExportQueue(true);
    const a = q.enqueue(req());
    const b = q.enqueue(req());
    q.progress(a.id, 0.5, 10, 5);
    q.progress(b.id, 0.1, 10, 20);
    expect(q.overallProgress()).toBeCloseTo(0.3, 5);
    q.complete(a.id, true);
    q.complete(b.id, true);
    expect(q.overallProgress()).toBeNull(); // idle
  });

  it("complete/abort on unknown or terminal ids is a no-op", () => {
    const q = new ExportQueue(false);
    const a = q.enqueue(req());
    q.complete(a.id, true);
    expect(q.complete(a.id, true)).toEqual([]);
    expect(q.abort(a.id).aborted).toBe(false);
    expect(q.abort(999).aborted).toBe(false);
  });
});

// ---- undistort remap map math --------------------------------------------

describe("undistort maps", () => {
  const cal = { fx: 1000, fy: 1000, cx: 640, cy: 480, dist: [0, 0, 0, 0, 0] };

  it("parses the wide-camera metadata (production keys)", () => {
    const parsed = parseWideCalibration({
      camera_matrix: JSON.stringify([[1000, 0, 640], [0, 1000, 480], [0, 0, 1]]),
      dist_coeffs: JSON.stringify([0.1, -0.05, 0, 0, 0.01]),
    });
    expect(parsed).toEqual({ fx: 1000, fy: 1000, cx: 640, cy: 480, dist: [0.1, -0.05, 0, 0, 0.01] });
  });

  it("tolerates the alternate matrix/distortion spelling; rejects absent", () => {
    expect(parseWideCalibration({ matrix: JSON.stringify([[800, 0, 320], [0, 800, 240], [0, 0, 1]]) }))
      .toMatchObject({ fx: 800, cx: 320 });
    expect(parseWideCalibration(null)).toBeNull();
    expect(parseWideCalibration({ foo: "bar" })).toBeNull();
  });

  it("zero distortion → identity map", () => {
    const m = buildRemapMaps(cal, 1280, 960);
    // principal point maps to itself; an arbitrary pixel maps to itself.
    const idx = (u: number, v: number) => v * 1280 + u;
    expect(m.xmap[idx(640, 480)]).toBeCloseTo(640, 3);
    expect(m.ymap[idx(640, 480)]).toBeCloseTo(480, 3);
    expect(m.xmap[idx(100, 200)]).toBeCloseTo(100, 3);
    expect(m.ymap[idx(100, 200)]).toBeCloseTo(200, 3);
  });

  it("positive k1 (barrel) pulls the source sample outward from a corner", () => {
    const barrel = { ...cal, dist: [0.2, 0, 0, 0, 0] };
    const m = buildRemapMaps(barrel, 1280, 960);
    // At (0,0): x=-0.64, y=-0.48, r2=0.64+0.2304=0.8704; radial=1+0.2*0.8704.
    // source x = fx*x*radial + cx = 1000*(-0.64)*1.17408 + 640 ≈ -111.4 → OOB.
    const src = m.xmap[0]!;
    expect(src).toBeLessThan(0); // sampled from outside the frame (fill region)
  });

  it("PGM16 header + big-endian samples; OOB → fill sentinel", () => {
    const map = new Float32Array([0, 5, -1, 3000]); // -1 and 3000 are OOB for dim=1000
    const pgm = toPgm16(map, 2, 2, 1000);
    const text = new TextDecoder().decode(pgm.subarray(0, 16));
    expect(text.startsWith("P5\n2 2\n65535\n")).toBe(true);
    const body = pgm.subarray(pgm.length - 8);
    // sample0 = 0
    expect((body[0]! << 8) | body[1]!).toBe(0);
    // sample1 = 5 (big-endian)
    expect((body[2]! << 8) | body[3]!).toBe(5);
    // sample2 = -1 → fill; sample3 = 3000 ≥ dim → fill
    expect((body[4]! << 8) | body[5]!).toBe(REMAP_FILL);
    expect((body[6]! << 8) | body[7]!).toBe(REMAP_FILL);
  });
});

// ---- banner episode state machine ----------------------------------------

describe("banner state machine", () => {
  it("shows while active, hides after dismiss, re-arms on clear→set", () => {
    let s = initialBannerState;
    expect(bannerVisible(s)).toBe(false);
    s = setActive(s, true);
    expect(bannerVisible(s)).toBe(true); // session started → banner
    s = dismiss(s);
    expect(bannerVisible(s)).toBe(false); // dismissed this episode
    s = setActive(s, true); // still active (idempotent) → stays dismissed
    expect(bannerVisible(s)).toBe(false);
    s = setActive(s, false); // app closed → episode ends, re-arm
    expect(bannerVisible(s)).toBe(false);
    s = setActive(s, true); // new session → banner reappears
    expect(bannerVisible(s)).toBe(true);
  });

  it("dismiss with no active episode is a no-op", () => {
    expect(dismiss(initialBannerState)).toBe(initialBannerState);
  });
});

// ---- ffmpeg discovery -----------------------------------------------------

describe("resolveFfmpegPath", () => {
  it("finds ffmpeg on PATH first", () => {
    const found = resolveFfmpegPath("/usr/bin:/opt/homebrew/bin", (p) => p === "/opt/homebrew/bin/ffmpeg");
    expect(found).toBe("/opt/homebrew/bin/ffmpeg");
  });
  it("falls back to the common locations when PATH lacks it (Finder launchd PATH)", () => {
    const found = resolveFfmpegPath("/usr/bin:/bin", (p) => p === "/opt/homebrew/bin/ffmpeg", COMMON_FFMPEG_PATHS);
    expect(found).toBe("/opt/homebrew/bin/ffmpeg");
  });
  it("returns null when nothing exists", () => {
    expect(resolveFfmpegPath("/usr/bin", () => false)).toBeNull();
  });
});

// ---- ffmpeg argv builder --------------------------------------------------

describe("buildFfmpegArgs", () => {
  it("pipes rawvideo rgba on stdin at the target fps", () => {
    const args = buildFfmpegArgs({ request: req({ fps: 24 }), width: 640, height: 480 });
    expect(args).toContain("-f");
    expect(args).toContain("rawvideo");
    const i = args.indexOf("-pix_fmt");
    expect(args[i + 1]).toBe("rgba");
    expect(args).toContain("640x480");
    expect(args[args.indexOf("-r") + 1]).toBe("24");
    expect(args).toContain("libx264");
    expect(args.at(-1)).toBe("/tmp/out.mp4");
  });

  it("adds the remap filter with a transparent fill when alpha is on", () => {
    const args = buildFfmpegArgs({
      request: req({ codec: "prores", pixfmt: "yuva444p10le", profile: "4444", undistort: true, alpha: true, outputPath: "/tmp/o.mov" }),
      width: 100,
      height: 80,
      xmapPath: "/tmp/x.pgm",
      ymapPath: "/tmp/y.pgm",
    });
    const fc = args[args.indexOf("-filter_complex") + 1]!;
    expect(fc).toContain("remap=fill=black@0.0");
    expect(args).toContain("/tmp/x.pgm");
    expect(args).toContain("prores_ks");
    expect(args[args.indexOf("-profile:v") + 1]).toBe("4"); // 4444
  });

  it("undistort with opaque black fill when alpha is off", () => {
    const args = buildFfmpegArgs({
      request: req({ undistort: true, alpha: false }),
      width: 8,
      height: 8,
      xmapPath: "/tmp/x.pgm",
      ymapPath: "/tmp/y.pgm",
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("remap=fill=black[");
  });

  it("throws if undistort is requested without maps", () => {
    expect(() => buildFfmpegArgs({ request: req({ undistort: true }), width: 8, height: 8 })).toThrow();
  });
});

// ---- rgba normalization ---------------------------------------------------

describe("toRGBA", () => {
  it("gray → replicated rgb, opaque alpha", () => {
    expect([...toRGBA(new Uint8Array([10, 20]), 1, 2)]).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
  });
  it("rgb → rgba opaque", () => {
    expect([...toRGBA(new Uint8Array([1, 2, 3]), 3, 1)]).toEqual([1, 2, 3, 255]);
  });
  it("rgba → verbatim", () => {
    expect([...toRGBA(new Uint8Array([1, 2, 3, 4]), 4, 1)]).toEqual([1, 2, 3, 4]);
  });
});
