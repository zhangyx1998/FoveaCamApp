import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pack12p } from "../../playground/bench-recorder/src/synth";

interface CodecFixture {
  vectors: Array<{
    name: string;
    samples: number[];
    packedHex: string;
  }>;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("12p codec fixtures", () => {
  it("pins the TS bench packer to the shared GenICam vectors", async () => {
    const fixture = JSON.parse(
      await readFile(
        resolve(process.cwd(), "../docs/schema/codec/12p-vectors.json"),
        "utf8",
      ),
    ) as CodecFixture;

    for (const vector of fixture.vectors) {
      expect(hex(pack12p(Uint16Array.from(vector.samples))), vector.name).toBe(
        vector.packedHex,
      );
    }
  });
});
