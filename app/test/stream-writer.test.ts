// StreamWriter worker handoff (docs/refactor/orchestrator.md §7.1 S3):
// writes keep the existing .stream/.meta format while disk I/O runs in a
// worker_threads worker fed by transferred ArrayBuffers.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import StreamWriter from "@orchestrator/stream-writer";

const tmpRoots: string[] = [];

function fakeFrame(values = [1, 2, 3, 4]) {
  return Object.assign(new Uint16Array(values), {
    shape: [2, 2],
    channels: 1,
  }) as any;
}

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "foveacam-stream-writer-"));
  tmpRoots.push(dir);
  return dir;
}

describe("StreamWriter worker", () => {
  afterEach(async () => {
    await Promise.all(tmpRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("writes the existing stream binary and JSONL metadata format", async () => {
    const dir = await tempRoot();
    const frame = fakeFrame();
    const writer = new StreamWriter(dir, "left");

    writer.write(frame, "Mono12p", 12.5, { tag: "sample" });
    await writer.flush();

    const bytes = await readFile(join(dir, "left.stream"));
    expect(
      Array.from(
        new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
      ),
    ).toEqual(Array.from(frame));
    const lines = (await readFile(join(dir, "left.meta"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      o: 0,
      n: frame.byteLength,
      d: "U16",
      s: [2, 2],
      t: 12.5,
      f: "Mono12p",
      b: 12,
      x: { tag: "sample" },
    });
  });

  it("drops frames when the worker queue is full", async () => {
    const dir = await tempRoot();
    const writer = new StreamWriter(dir, "overflow", { maxQueuedFrames: 1 });

    writer.write(fakeFrame([1, 1, 1, 1]), "Mono16");
    writer.write(fakeFrame([2, 2, 2, 2]), "Mono16");
    await writer.flush();

    expect(writer.summary).toEqual({ frames: 1, dropped: 1, bytes: 8 });
    const bytes = await readFile(join(dir, "overflow.stream"));
    expect(bytes.byteLength).toBe(8);
  });
});
