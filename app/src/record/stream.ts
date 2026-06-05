// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import type { Mat } from "core/Vision";
import type { PixelFormat } from "core/Aravis";
import { FreqMeter } from "@lib/util/perf";
import { dtypeOf, type Dtype } from "@lib/util/dtype";

export type CompressionFormat = "lz4" | "zstd";

export interface FrameMeta<X extends Extensions = Extensions> {
  /** offset */
  o: number;
  /** length in bytes (maybe compressed) */
  n: number;
  /** compresion type, raw if omitted */
  c?: CompressionFormat;
  /** shape of the frame data */
  s: number[];
  /** dtype */
  d: Dtype;
  /** timestamp in seconds, floating point */
  t: number;
  /** pixel format */
  f: PixelFormat;
  /** extra metadata */
  x?: X;
}

interface AffineExtension {
  /** 3x3 homography matrix in row-major order */
  affine: number[];
}

type Extensions = Partial<AffineExtension>;

export default class StreamWriter {
  static readonly highWaterMark = 256 * 1024 * 1024;
  private readonly stream: WriteStream;
  private readonly meta: WriteStream;
  readonly fps = new FreqMeter();
  frameCount = 0;
  dropped = 0;
  private byteOffset = 0;
  private pending: Promise<void> | null = null;

  constructor(
    basePath: string,
    private readonly name: string,
  ) {
    const metaPath = resolve(basePath, `${name}.meta`);
    const streamPath = resolve(basePath, `${name}.stream`);
    const { highWaterMark } = StreamWriter;
    this.meta = createWriteStream(metaPath, { encoding: "utf8" });
    this.stream = createWriteStream(streamPath, { highWaterMark });
  }

  write(
    frame: Mat,
    format: PixelFormat,
    timestamp = performance.now() / 1000,
    extra?: Record<string, unknown>,
  ) {
    if (this.pending) {
      this.dropped++;
      return;
    }
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const entry: FrameMeta = {
      o: this.byteOffset,
      n: buf.byteLength,
      d: dtypeOf(frame),
      s: [...frame.shape],
      t: timestamp,
      f: format,
      x: extra,
    };
    this.byteOffset += buf.byteLength;
    this.frameCount++;
    this.fps.tick();

    const streamOk = this.stream.write(buf);
    this.meta.write(JSON.stringify(entry) + "\n");

    if (!streamOk) {
      console.warn(`[record] backpressure on stream "${this.name}"`);
      this.pending = new Promise<void>((resolve) => {
        this.stream.once("drain", () => {
          this.pending = null;
          resolve();
        });
      });
    }
  }

  flush(): Promise<void> {
    const p = this.pending ?? Promise.resolve();
    return p.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.meta.end(() => {
            this.stream.end(() => resolve());
            this.stream.once("error", reject);
          });
          this.meta.once("error", reject);
        }),
    );
  }

  get summary() {
    return {
      frames: this.frameCount,
      dropped: this.dropped,
      bytes: this.byteOffset,
    };
  }
}
