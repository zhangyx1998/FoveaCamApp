import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Pack an array of 12-bit samples (0..4095) using GenICam `*12p` layout
 *  (2 pixels -> 3 bytes). */
function pack12p(samples: Uint16Array): Uint8Array {
  const n = samples.length;
  const out = new Uint8Array(Math.ceil((n * 3) / 2));
  let oi = 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    const a = samples[i]! & 0xfff;
    const b = samples[i + 1]! & 0xfff;
    out[oi++] = a & 0xff;
    out[oi++] = ((b & 0x0f) << 4) | (a >> 8);
    out[oi++] = b >> 4;
  }
  if (i < n) {
    const a = samples[i]! & 0xfff;
    out[oi++] = a & 0xff;
    out[oi++] = (a >> 8) & 0x0f;
  }
  return out;
}

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
