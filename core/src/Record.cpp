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

#include "AsyncTask.h"
#include "Record/McapWriter.h"
#include "Record/RecorderStream.h"
#include "ThreadMeter.h"
#include "napi-helper.h"

// Meter::Snapshot → JS (defined in core/lib/Aravis/ConverterStream.cpp; forward
// declared to avoid pulling the Aravis headers' global `Object` template into
// this TU's `using namespace Napi`).
namespace Arv {
Napi::Value meterSnapshotToJs(Napi::Env env, const Meter::Snapshot &s);
}

// AsyncTask<T> resolves its promise via convert(env, container, result) — the
// AsyncWorker OnOK path uses the CONTAINER form, so BOTH forms are specialized
// (a missing form links under `-undefined dynamic_lookup` and segfaults at
// call) BEFORE the AsyncTask<Stats> instantiation below.
template <>
Napi::Value convert(Napi::Env env,
                    const Record::McapWriter::Stats &stats) noexcept {
  auto out = Napi::Object::New(env);
  out.Set("messageCount",
          Napi::BigInt::New(env, static_cast<uint64_t>(stats.messageCount)));
  out.Set("chunkCount", Napi::Number::New(env, stats.chunkCount));
  out.Set("bytes",
          Napi::Number::New(env, static_cast<double>(stats.byteCount)));
  return out;
}
template <>
Napi::Value convert(Napi::Env env, const Napi::Value & /*container*/,
                    const Record::McapWriter::Stats &stats) noexcept {
  return convert(env, stats);
}

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

// ============================================================================
// native-recorder Wave 2: the RECORDER BRICK surface (core.Recorder.*). The
// orchestrator's recorder-node host drives these — nothing per-frame crosses
// this boundary (frames flow producer-tap → writer thread entirely in C++).
// Handle-based registry, NAPI-thread only (the brick's own threads are
// internal). All schema/metadata constants are passed IN from JS (schema.ts
// stays the single source of truth — C++ carries no fovea constants).
// ============================================================================

static std::mutex g_recMutex;
static std::map<int, std::unique_ptr<Record::RecorderStream>> g_recorders;
static int g_nextRecorder = 1;

static Record::RecorderStream *recLookup(int handle) {
  auto it = g_recorders.find(handle);
  return it == g_recorders.end() ? nullptr : it->second.get();
}

static std::string strField(const Napi::Object &o, const char *k) {
  return o.Get(k).As<Napi::String>().Utf8Value();
}

// create(opts) -> handle. See RecorderConfig for the field inventory.
Napi::Value recorderCreate(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsObject(), TypeError, "Recorder.create(opts) required",
              env.Undefined());
    auto o = info[0].As<Napi::Object>();
    Record::RecorderConfig cfg;
    cfg.id = strField(o, "id");
    cfg.filePath = strField(o, "filePath");
    cfg.chunkBytes =
        static_cast<uint64_t>(o.Get("chunkBytes").As<Napi::Number>().DoubleValue());
    cfg.maxQueued = o.Get("maxQueuedFrames").As<Napi::Number>().Uint32Value();
    cfg.profile = strField(o, "profile");
    cfg.library = strField(o, "library");
    cfg.sessionMetaName = strField(o, "sessionMetaName");
    cfg.wideCameraMetaName = strField(o, "wideCameraMetaName");
    cfg.finalizeMetaName = strField(o, "finalizeMetaName");
    cfg.session = readMetaMap(o.Get("session"));
    if (o.Has("cameraMatrix") && o.Get("cameraMatrix").IsObject()) {
      cfg.cameraMatrix = readMetaMap(o.Get("cameraMatrix"));
      cfg.hasCameraMatrix = true;
    }
    cfg.rawFrameSchemaName = strField(o, "rawFrameSchemaName");
    cfg.rawFrameSchemaData = strField(o, "rawFrameSchemaData");
    cfg.descriptorSchemaName = strField(o, "descriptorSchemaName");
    cfg.descriptorSchemaData = strField(o, "descriptorSchemaData");
    cfg.telemetrySchemaName = strField(o, "telemetrySchemaName");
    cfg.telemetrySchemaData = strField(o, "telemetrySchemaData");
    cfg.schemaEncoding = strField(o, "schemaEncoding");
    cfg.rawFrameEncoding = strField(o, "rawFrameEncoding");
    cfg.descriptorEncoding = strField(o, "descriptorEncoding");
    cfg.telemetryEncoding = strField(o, "telemetryEncoding");
    cfg.telemetryTopic = strField(o, "telemetryTopic");
    auto rec = std::make_unique<Record::RecorderStream>(std::move(cfg));
    std::scoped_lock lock(g_recMutex);
    const int handle = g_nextRecorder++;
    g_recorders[handle] = std::move(rec);
    return Napi::Number::New(env, handle);
  }
  JS_EXCEPT(env.Undefined())
}

// addStream(handle, name, pipeId, metadataObj, wantsExtras)
Napi::Value recorderAddStream(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.addStream: bad handle",
              env.Undefined());
    rec->addStream(info[1].As<Napi::String>().Utf8Value(),
                   info[2].As<Napi::String>().Utf8Value(),
                   readMetaMap(info[3]),
                   info[4].ToBoolean().Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

Napi::Value recorderRemoveStream(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.removeStream: bad handle",
              env.Undefined());
    rec->removeStream(info[1].As<Napi::String>().Utf8Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

Napi::Value recorderAddDataStream(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.addDataStream: bad handle",
              env.Undefined());
    rec->addDataStream(info[1].As<Napi::String>().Utf8Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

Napi::Value recorderRemoveDataStream(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.removeDataStream: bad handle",
              env.Undefined());
    rec->removeDataStream(info[1].As<Napi::String>().Utf8Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

Napi::Value recorderPostData(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.postData: bad handle",
              env.Undefined());
    rec->postData(info[1].As<Napi::String>().Utf8Value(),
                  info[2].As<Napi::String>().Utf8Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// appendTelemetry(handle, seq, logTimeNs (bigint), payloadJson)
Napi::Value recorderAppendTelemetry(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.appendTelemetry: bad handle",
              env.Undefined());
    bool lossless = false;
    const int64_t logTimeNs =
        info[2].IsBigInt() ? info[2].As<Napi::BigInt>().Int64Value(&lossless)
                           : static_cast<int64_t>(
                                 info[2].As<Napi::Number>().DoubleValue());
    rec->appendTelemetry(info[1].As<Napi::Number>().Uint32Value(), logTimeNs,
                         info[3].As<Napi::String>().Utf8Value());
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// takeNotices(handle) -> [{stream, seq, logTimeNs, tNs}] (extras dispatch,
// drained on the host's low-rate poll — out-of-loop, never per-frame JS).
Napi::Value recorderTakeNotices(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.takeNotices: bad handle",
              env.Undefined());
    auto notices = rec->takeNotices();
    auto arr = Napi::Array::New(env, notices.size());
    for (size_t i = 0; i < notices.size(); ++i) {
      auto row = Napi::Object::New(env);
      row.Set("stream", Napi::String::New(env, notices[i].stream));
      row.Set("seq", Napi::Number::New(env, notices[i].seq));
      row.Set("logTimeNs",
              Napi::BigInt::New(env, static_cast<int64_t>(notices[i].logTimeNs)));
      row.Set("tNs", Napi::BigInt::New(env, static_cast<int64_t>(notices[i].tNs)));
      arr.Set(static_cast<uint32_t>(i), row);
    }
    return arr;
  }
  JS_EXCEPT(env.Undefined())
}

// stats(handle) -> { [stream]: {ingested,dropped,droppedQueue,droppedRing,
// written,bytes} } — the recorder-node.ts StreamCounters shape, verbatim.
Napi::Value recorderStats(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.stats: bad handle",
              env.Undefined());
    auto stats = rec->stats();
    auto out = Napi::Object::New(env);
    for (const auto &[name, c] : stats) {
      auto row = Napi::Object::New(env);
      row.Set("ingested", Napi::Number::New(env, static_cast<double>(c.ingested)));
      row.Set("dropped", Napi::Number::New(env, static_cast<double>(c.dropped)));
      row.Set("droppedQueue",
              Napi::Number::New(env, static_cast<double>(c.droppedQueue)));
      row.Set("droppedRing",
              Napi::Number::New(env, static_cast<double>(c.droppedRing)));
      row.Set("written", Napi::Number::New(env, static_cast<double>(c.written)));
      row.Set("bytes", Napi::Number::New(env, static_cast<double>(c.bytes)));
      out.Set(name, row);
    }
    return out;
  }
  JS_EXCEPT(env.Undefined())
}

// probe(handle) -> the writer thread's profiling metric block.
Napi::Value recorderProbe(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    JS_ASSERT(rec != nullptr, Error, "Recorder.probe: bad handle",
              env.Undefined());
    return Arv::meterSnapshotToJs(env, rec->probe());
  }
  JS_EXCEPT(env.Undefined())
}

// finalize(handle, durationSec) -> Promise<{messageCount, chunkCount, bytes}>.
// Phase 1 (tap detach + drain marker) runs HERE on the NAPI thread; the
// AsyncTask thread only waits for the writer's completion signal. The handle
// stays in the registry — call destroy() after the promise settles.
Napi::Value recorderFinalize(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    Record::RecorderStream *rec = nullptr;
    {
      std::scoped_lock lock(g_recMutex);
      rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    }
    JS_ASSERT(rec != nullptr, Error, "Recorder.finalize: bad handle",
              env.Undefined());
    const double durationSec = info[1].As<Napi::Number>().DoubleValue();
    rec->beginFinalize(durationSec);
    return AsyncTask<Record::McapWriter::Stats>::run(
        env, [rec] { return rec->waitFinalize(); }, "Recorder.finalize");
  }
  JS_EXCEPT(env.Undefined())
}

// abort(handle) — crash-shape stop; unblocks a pending finalize (truncated).
Napi::Value recorderAbort(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::scoped_lock lock(g_recMutex);
    auto *rec = recLookup(info[0].As<Napi::Number>().Int32Value());
    if (rec)
      rec->abort();
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// destroy(handle) — join + free. Call ONLY after the finalize promise settled
// (a pending waitFinalize must not outlive the object).
Napi::Value recorderDestroy(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    std::unique_ptr<Record::RecorderStream> rec;
    {
      std::scoped_lock lock(g_recMutex);
      auto it = g_recorders.find(info[0].As<Napi::Number>().Int32Value());
      if (it != g_recorders.end()) {
        rec = std::move(it->second);
        g_recorders.erase(it);
      }
    }
    // Destructs OUTSIDE the registry lock (abort + writer-thread join).
    rec.reset();
    return env.Undefined();
  }
  JS_EXCEPT(env.Undefined())
}

// Registers the `core.Recorder` namespace onto the root exports.
void exportRecorderNamespace(Napi::Env env, Napi::Object &exports) {
  auto ns = Napi::Object::New(env);
  ns.Set("create", Function::New<recorderCreate>(env, "create"));
  ns.Set("addStream", Function::New<recorderAddStream>(env, "addStream"));
  ns.Set("removeStream",
         Function::New<recorderRemoveStream>(env, "removeStream"));
  ns.Set("addDataStream",
         Function::New<recorderAddDataStream>(env, "addDataStream"));
  ns.Set("removeDataStream",
         Function::New<recorderRemoveDataStream>(env, "removeDataStream"));
  ns.Set("postData", Function::New<recorderPostData>(env, "postData"));
  ns.Set("appendTelemetry",
         Function::New<recorderAppendTelemetry>(env, "appendTelemetry"));
  ns.Set("takeNotices", Function::New<recorderTakeNotices>(env, "takeNotices"));
  ns.Set("stats", Function::New<recorderStats>(env, "stats"));
  ns.Set("probe", Function::New<recorderProbe>(env, "probe"));
  ns.Set("finalize", Function::New<recorderFinalize>(env, "finalize"));
  ns.Set("abort", Function::New<recorderAbort>(env, "abort"));
  ns.Set("destroy", Function::New<recorderDestroy>(env, "destroy"));
  exports.Set("Recorder", ns);
}

} // namespace Rec
