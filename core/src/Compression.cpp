// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <lz4.h>
#include <napi.h>

#include "napi-helper.h"

using namespace Napi;

// LZ4.encode(input: Buffer) => Buffer
static FN(encode) {
  auto env = info.Env();
  try {
    auto buf = info[0].As<Napi::Buffer<char>>();
    const char *src = buf.Data();
    const int srcSize = static_cast<int>(buf.ByteLength());
    const int maxDstSize = LZ4_compressBound(srcSize);
    auto dst = Napi::Buffer<char>::New(env, maxDstSize);
    const int compressedSize =
        LZ4_compress_default(src, dst.Data(), srcSize, maxDstSize);
    JS_ASSERT(compressedSize > 0, Error, "LZ4 compression failed",
              env.Undefined());
    // Return a view over the actually-used portion of the buffer
    return Napi::Buffer<char>::Copy(env, dst.Data(), compressedSize);
  }
  JS_EXCEPT(env.Undefined())
}

// LZ4.decode(input: Buffer, originalSize: number) => Buffer
static FN(decode) {
  auto env = info.Env();
  try {
    auto buf = info[0].As<Napi::Buffer<char>>();
    const char *src = buf.Data();
    const int srcSize = static_cast<int>(buf.ByteLength());
    const int originalSize = info[1].As<Napi::Number>().Int32Value();
    auto dst = Napi::Buffer<char>::New(env, originalSize);
    const int decompressedSize =
        LZ4_decompress_safe(src, dst.Data(), srcSize, originalSize);
    JS_ASSERT(decompressedSize >= 0, Error, "LZ4 decompression failed",
              env.Undefined());
    return dst;
  }
  JS_EXCEPT(env.Undefined())
}

#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
void exportCompressionNamespace(Napi::Env env, Napi::Object &exports) {
  auto LZ4 = Object::New(env);
  EXPORT(LZ4, encode);
  EXPORT(LZ4, decode);
  exports.Set("LZ4", LZ4);
}
#undef EXPORT
