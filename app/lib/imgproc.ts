// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { Frame, Stream } from "core/Aravis";
import { cvtColor, Mat } from "core/Vision";
import { createMat } from "./mat";
import abortable from "./abortable.next";

export function stack(stream: Stream<Frame>, count: number) {
  return abortable(async (abortable) => {
    let out: Mat<Float32Array> | null = null;
    let fmt: Frame["raw_format"] | null = null;
    let n = 0;
    for (const frame of abortable.iter(stream)) {
      if (!frame) {
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }
      if (n + 1 > count) break;
      n += 1;
      const { raw, raw_format } = frame;
      frame.release();
      console.log({ raw, raw_format });
      if (out === null) {
        out = createMat(Float32Array, raw.shape, raw.channels);
        fmt = raw_format;
      }
      for (let i = 0; i < raw.length; i++) out[i] += raw[i] as number;
      await new Promise((r) => setTimeout(r, 1));
    }
    if (out === null) throw new Error("No frames received");
    for (let i = 0; i < out.length; i++) out[i] /= n;
    return { image: out, format: fmt! };
  });
}

export function makeBGR(mat: Mat, format: Frame["raw_format"]) {
  switch (format) {
    case "BayerBG8":
    case "BayerBG16":
      return cvtColor(mat, "BayerBG2BGR");
    case "BayerGB8":
    case "BayerGB16":
      return cvtColor(mat, "BayerGB2BGR");
    case "BayerRG8":
    case "BayerRG16":
      return cvtColor(mat, "BayerRG2BGR");
    case "BayerGR8":
    case "BayerGR16":
      return cvtColor(mat, "BayerGR2BGR");
  }
  switch (mat.channels) {
    case 1:
      return cvtColor(mat, "GRAY2BGR");
    case 3:
      return mat;
    case 4:
      return cvtColor(mat, "BGRA2BGR");
    default:
      throw new Error(
        `Unsupported format: ${format} with ${mat.channels} channels`,
      );
  }
}

export function makeBGRA(mat: Mat, format: Frame["raw_format"]) {
  return cvtColor(makeBGR(mat, format), "BGR2BGRA");
}
