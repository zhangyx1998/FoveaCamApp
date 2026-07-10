// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder: NAPI surface over the hand-rolled C++ MCAP writer
// (core/lib/Record/McapWriter). This is a TEST/CONFORMANCE surface only — the
// live recorder brick (RecorderStream) drives McapWriter directly in C++ (no
// NAPI per frame). These `__mcap*` root exports let core/test/39-mcap-writer.ts
// drive the native writer with the SAME inputs it feeds @mcap/core and compare
// the two containers byte-for-byte. Handle-based (an integer handle indexes a
// registry) to avoid a CoreObject lifetime surface for a test-only path.

#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#include <napi.h>

#include "Record/McapWriter.h"
#include "napi-helper.h"

using namespace Napi;

namespace Rec {

static std::mutex g_mutex;
static std::map<int, std::unique_ptr<Record::McapWriter>> g_writers;
static int g_nextHandle = 1;

static Record::McapWriter *lookup(int handle) {
  auto it = g_writers.find(handle);
  return it == g_writers.end() ? nullptr : it->second.get();
}

// Read a JS object as ordered key/value string pairs (object property order).
static Record::MetaMap readMetaMap(const Napi::Value &v) {
  Record::MetaMap out;
  if (!v.IsObject())
    return out;
  auto obj = v.As<Napi::Object>();
  auto names = obj.GetPropertyNames();
  for (uint32_t i = 0; i < names.Length(); ++i) {
    auto key = names.Get(i).As<Napi::String>().Utf8Value();
    out.emplace_back(key, obj.Get(key).As<Napi::String>().Utf8Value());
  }
  return out;
}

static uint64_t readU64(const Napi::Value &v) {
  if (v.IsBigInt()) {
    bool lossless = false;
    return v.As<Napi::BigInt>().Uint64Value(&lossless);
  }
  return static_cast<uint64_t>(v.As<Napi::Number>().DoubleValue());
}

// __mcapOpen(chunkSize:number, path:string, profile:string, library:string) -> handle
Napi::Value __mcapOpen(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsNumber() && info[1].IsString() && info[2].IsString() &&
                  info[3].IsString(),
              TypeError, "__mcapOpen(chunkSize, path, profile, library)",
              env.Undefined());
    const uint64_t chunkSize =
        static_cast<uint64_t>(info[0].As<Napi::Number>().DoubleValue());
    const auto path = info[1].As<Napi::String>().Utf8Value();
    const auto profile = info[2].As<Napi::String>().Utf8Value();
    const auto library = info[3].As<Napi::String>().Utf8Value();
    auto writer = std::make_unique<Record::McapWriter>(chunkSize);
    writer->open(path, profile, library);
    std::scoped_lock lock(g_mutex);
    int handle = g_nextHandle++;
    g_writers[handle] = std::move(writer);
    return Napi::Number::New(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapRegisterSchema(handle, name, encoding, Uint8Array) -> id
Napi::Value __mcapRegisterSchema(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_mutex);
    auto *w = lookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(w != nullptr, Error, "__mcapRegisterSchema: bad handle",
              env.Undefined());
    const auto name = info[1].As<Napi::String>().Utf8Value();
    const auto encoding = info[2].As<Napi::String>().Utf8Value();
    auto data = info[3].As<Napi::Uint8Array>();
    uint16_t id = w->registerSchema(name, encoding, data.Data(),
                                    data.ByteLength());
    return Napi::Number::New(env, id);
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapRegisterChannel(handle, schemaId, topic, messageEncoding, metadataObj) -> id
Napi::Value __mcapRegisterChannel(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_mutex);
    auto *w = lookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(w != nullptr, Error, "__mcapRegisterChannel: bad handle",
              env.Undefined());
    const uint16_t schemaId =
        static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value());
    const auto topic = info[2].As<Napi::String>().Utf8Value();
    const auto enc = info[3].As<Napi::String>().Utf8Value();
    auto meta = readMetaMap(info[4]);
    uint16_t id = w->registerChannel(schemaId, topic, enc, meta);
    return Napi::Number::New(env, id);
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapAddMessage(handle, channelId, sequence, logTime, publishTime, Uint8Array)
Napi::Value __mcapAddMessage(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_mutex);
    auto *w = lookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(w != nullptr, Error, "__mcapAddMessage: bad handle",
              env.Undefined());
    const uint16_t channelId =
        static_cast<uint16_t>(info[1].As<Napi::Number>().Uint32Value());
    const uint32_t sequence = info[2].As<Napi::Number>().Uint32Value();
    const uint64_t logTime = readU64(info[3]);
    const uint64_t publishTime = readU64(info[4]);
    auto data = info[5].As<Napi::Uint8Array>();
    w->addMessage(channelId, sequence, logTime, publishTime, data.Data(),
                  data.ByteLength());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapAddMetadata(handle, name, metadataObj)
Napi::Value __mcapAddMetadata(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_mutex);
    auto *w = lookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(w != nullptr, Error, "__mcapAddMetadata: bad handle",
              env.Undefined());
    const auto name = info[1].As<Napi::String>().Utf8Value();
    auto meta = readMetaMap(info[2]);
    w->addMetadata(name, meta);
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapEnd(handle) -> { messageCount, chunkCount, byteCount }
Napi::Value __mcapEnd(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::unique_ptr<Record::McapWriter> w;
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_writers.find(info[0].As<Napi::Number>().Int32Value());
      JS_ASSERT(it != g_writers.end(), Error, "__mcapEnd: bad handle",
                env.Undefined());
      w = std::move(it->second);
      g_writers.erase(it);
    }
    auto stats = w->end();
    auto out = Napi::Object::New(env);
    out.Set("messageCount",
            Napi::BigInt::New(env, static_cast<uint64_t>(stats.messageCount)));
    out.Set("chunkCount", Napi::Number::New(env, stats.chunkCount));
    out.Set("byteCount", Napi::Number::New(env, static_cast<double>(stats.byteCount)));
    return out;
  }
  JS_EXCEPT(env.Undefined())
}

// __mcapAbort(handle) — crash-shape close (no footer/summary).
Napi::Value __mcapAbort(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::unique_ptr<Record::McapWriter> w;
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_writers.find(info[0].As<Napi::Number>().Int32Value());
      if (it != g_writers.end()) {
        w = std::move(it->second);
        g_writers.erase(it);
      }
    }
    if (w)
      w->abort();
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

} // namespace Rec
