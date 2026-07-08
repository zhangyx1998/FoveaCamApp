// C-16: the WS1 pipe contract advertises typed pipes and brokers a one-time
// connect handshake — no per-frame Channel traffic. Pin the shape so the
// scaffold's broker surface can't drift.

import { describe, expect, it } from "vitest";
import { pipes, type PipeSpec, type PipeHandle } from "@lib/orchestrator/pipe-contract";

describe("pipe contract (C-16)", () => {
  it("advertises pipes as a keyed discovery Record + connect/disconnect broker", () => {
    expect(pipes.state.pipes).toEqual({}); // C-20: keyed Record, seeded + diffed
    expect(Object.keys(pipes.commands).sort()).toEqual([
      "connectPipe",
      "disconnectPipe",
    ]);
  });

  it("carries no per-frame frame topics (pixels flow via shm, not the Channel)", () => {
    expect(pipes.frames).toEqual([]);
  });

  it("PipeSpec declares explicit byte typing (C-P12): bytesPerFrame is authoritative", () => {
    // A U16 pipe: bytesPerFrame exceeds width*height*channels — the whole point
    // of declaring it rather than inferring from shape.
    const spec: PipeSpec = {
      id: "preview:L",
      pixelFormat: "Mono16",
      dtype: "U16",
      width: 640,
      height: 480,
      channels: 1,
      stride: 640 * 2,
      bytesPerFrame: 640 * 480 * 2,
      ringDepth: 3,
    };
    expect(spec.bytesPerFrame).toBe(640 * 480 * 2);
    expect(spec.bytesPerFrame).toBeGreaterThan(spec.width * spec.height * spec.channels);

    const handle: PipeHandle = {
      pipeId: spec.id,
      shmName: "/fv.pabc.g1",
      spec,
      ringDepth: spec.ringDepth,
      epoch: 1,
      headerLayout: { layoutVersion: 3, magic: "FVSHMRG" },
    };
    expect(handle.spec).toBe(spec);
    expect(handle.headerLayout.layoutVersion).toBe(3);
  });
});
