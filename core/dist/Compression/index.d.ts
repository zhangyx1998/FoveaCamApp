// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

declare module "core/Compression" {
  export namespace LZ4 {
    /** Compress a buffer using LZ4. Returns the compressed buffer. */
    function encode(input: Buffer): Buffer;
    /** Decompress an LZ4-compressed buffer. `originalSize` must match the uncompressed size. */
    function decode(input: Buffer, originalSize: number): Buffer;
  }
}
