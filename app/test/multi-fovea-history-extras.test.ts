// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Part A (free-run extras via interpolated actuation history): the pure
// `historyExtras` derivation + the `onFrame` stamping DECISION through the
// recording controller — calibrated+history → stamped with the new
// `volt.source: "history-interpolated"`; empty history → omitted; uncalibrated
// → omitted; a trigger anchor still wins over the history fallback. Everything
// injected — no native core, no mirror hardware.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMultiFoveaRecording,
  historyExtras,
  type FreeRunConversions,
  type MultiFoveaRecordingDeps,
} from "../modules/multi-fovea/recording";
import { createRawPipeRegistry, type RawPipeSeam } from "@orchestrator/raw-pipe";
import { ANCHOR_PAYLOAD } from "@orchestrator/anchor-node";
import type { MirrorAt } from "@orchestrator/mirror-history";
import type {
  RecorderNodeOptions,
  RecorderNodeHandle,
  RecorderPipeConnection,
} from "@orchestrator/recorder-node";
import type { Pos } from "@lib/controller-codec";

// A conversions fake: V2A returns volt+offset (distinct per eye), A2H returns a
// 9-number row-major H encoding the eye + angle so assertions can prove wiring.
const fakeConversions = (): FreeRunConversions => ({
  V2A: {
    L: (v: Pos) => ({ x: v.x + 1, y: v.y + 1 }),
    R: (v: Pos) => ({ x: v.x + 2, y: v.y + 2 }),
  },
  A2H: {
    L: (a) => [a.x, a.y, 0, 0, 1, 0, 0, 0, 1] as unknown as never,
    R: (a) => [a.x, a.y, 9, 0, 1, 0, 0, 0, 1] as unknown as never,
  },
});

const mirror = (left: Pos, right: Pos): MirrorAt => ({
  left,
  right,
  ageNs: 0n,
  interpolated: true,
});

describe("historyExtras (pure)", () => {
  it("stamps volt/angle/affine with volt.source history-interpolated (calibrated + history)", () => {
    const e = historyExtras(mirror({ x: 5, y: 6 }, { x: 7, y: 8 }), fakeConversions(), "L")!;
    expect(e).toBeTruthy();
    expect(e.volt).toEqual({ x: 5, y: 6 });
    expect(e["volt.source"]).toBe("history-interpolated");
    expect(e["volt.unit"]).toBe("volt");
    expect(e.angle).toEqual({ x: 6, y: 7 }); // V2A.L adds +1
    expect(e["angle.unit"]).toBe("radian");
    // affine = A2H.L(angle) → [angle.x, angle.y, 0, ...] as a plain 9-array.
    expect(e.affine).toEqual([6, 7, 0, 0, 1, 0, 0, 0, 1]);
  });

  it("uses the RIGHT eye's volt + conversions for side R", () => {
    const e = historyExtras(mirror({ x: 5, y: 6 }, { x: 7, y: 8 }), fakeConversions(), "R")!;
    expect(e.volt).toEqual({ x: 7, y: 8 });
    expect(e.angle).toEqual({ x: 9, y: 10 }); // V2A.R adds +2
    expect((e.affine as number[])[2]).toBe(9); // A2H.R marker
  });

  it("returns null when the history is empty/too old (mirror null)", () => {
    expect(historyExtras(null, fakeConversions(), "L")).toBeNull();
  });

  it("returns null when the triple is uncalibrated (conv null)", () => {
    expect(historyExtras(mirror({ x: 1, y: 1 }, { x: 1, y: 1 }), null, "L")).toBeNull();
  });
});

// --- onFrame decision through the controller --------------------------------

function harness(overrides: Partial<MultiFoveaRecordingDeps> = {}) {
  const seam: RawPipeSeam = {
    advertise: () => 1,
    unadvertise: () => {},
    attach: () => {},
    detach: () => {},
  };
  let captured: RecorderNodeOptions | null = null;
  const createNode = (options: RecorderNodeOptions): RecorderNodeHandle => {
    captured = options;
    return {
      id: options.id,
      filePath: join(options.path, "r.fovea"),
      stats: () => ({}),
      addStream: () => {},
      removeStream: () => {},
      addDataStream: () => {},
      removeDataStream: () => {},
      postData: () => {},
      stop: async () => ({ messageCount: "0", chunkCount: 0, bytes: 0 }),
    };
  };
  const cam = (serial: string) => ({
    source: { serial, pixel_format: "BayerRG12p", getFeatureInt: () => 640 },
    camera: { native: serial },
  });
  const deps: MultiFoveaRecordingDeps = {
    cameras: () => ({ L: cam("SL"), C: cam("SC"), R: cam("SR") }),
    wideCamera: () => null,
    rawPipes: createRawPipeRegistry(seam),
    connect: (pipeId): RecorderPipeConnection => ({
      shmName: `shm:${pipeId}`,
      spec: {
        pixelFormat: "BayerRG12p",
        dtype: "U8",
        width: 640,
        height: 480,
        channels: 1,
        bytesPerFrame: 960 * 480,
        stride: 960,
      },
      release: () => {},
    }),
    compressStreams: () => ({ left: false, center: false, right: false }),
    readMethod: async () => "none",
    finished: () => {},
    telemetry: () => {},
    createNode,
    ...overrides,
  };
  const controller = createMultiFoveaRecording(deps);
  return { controller, onFrame: () => captured!.onFrame! };
}

describe("onFrame free-run stamping decision", () => {
  it("stamps history-interpolated extras for a free-run L frame (calibrated + history)", async () => {
    const { controller, onFrame } = harness({
      mirrorAt: () => mirror({ x: 5, y: 6 }, { x: 7, y: 8 }),
      conversions: () => fakeConversions(),
    });
    await controller.start("/tmp/mf");
    const extras = onFrame()("left", 1, 1000n) as Record<string, unknown>;
    expect(extras["volt.source"]).toBe("history-interpolated");
    expect(extras.volt).toEqual({ x: 5, y: 6 });
    expect(extras.affine).toBeTruthy();
  });

  it("omits extras when the history is empty (mirrorAt → null)", async () => {
    const { controller, onFrame } = harness({
      mirrorAt: () => null,
      conversions: () => fakeConversions(),
    });
    await controller.start("/tmp/mf");
    expect(onFrame()("left", 1, 1000n)).toBeNull();
  });

  it("omits angle/affine on an uncalibrated triple (conversions → null)", async () => {
    const { controller, onFrame } = harness({
      mirrorAt: () => mirror({ x: 5, y: 6 }, { x: 7, y: 8 }),
      conversions: () => null,
    });
    await controller.start("/tmp/mf");
    expect(onFrame()("left", 1, 1000n)).toBeNull();
  });

  it("posts NO extras for the center (wide) stream", async () => {
    const { controller, onFrame } = harness({
      mirrorAt: () => mirror({ x: 5, y: 6 }, { x: 7, y: 8 }),
      conversions: () => fakeConversions(),
    });
    await controller.start("/tmp/mf");
    expect(onFrame()("center", 1, 1000n)).toBeNull();
  });

  it("a trigger anchor WINS over the history fallback (fin-averaged)", async () => {
    const { controller, onFrame } = harness({
      mirrorAt: () => mirror({ x: 5, y: 6 }, { x: 7, y: 8 }),
      conversions: () => fakeConversions(),
    });
    await controller.start("/tmp/mf");
    // Bind a full anchor to dts 1000 for this stream.
    const payload = new Float64Array(ANCHOR_PAYLOAD.LEN_FULL);
    controller.onPairRecord({
      stream: 1,
      left: { deviceTimestamp: 1000n } as never,
      right: { deviceTimestamp: 2000n } as never,
      payload,
    } as never);
    const extras = onFrame()("left", 1, 1000n) as Record<string, unknown>;
    expect(extras["volt.source"]).toBe("fin-averaged");
  });
});
