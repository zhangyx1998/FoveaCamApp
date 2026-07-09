// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
// N-API glue over the shared, libc-only read TU (`ShmRead.{h,cpp}`). All the
// mapping / header validation / slot addressing / seqlock logic lives there and
// is compiled into the core target too; this file only marshals a `ReadResult`
// into a JS object. Intentionally does NOT include `ShmRing.h` (which pulls in
// the full N-API writer surface) — `ShmRead.h` + `ShmLayout.h` are enough.
#include "../include/ShmRead.h"

#include <memory>
#include <napi.h>
#include <stdexcept>
#include <string>

using namespace Napi;

namespace {

// Per-ENV addon state. The `Reader` class constructor reference MUST be
// per-environment, not a process-global static: this addon is loaded into a
// fresh V8 env in every worker_thread (the vision-worker bridge, WS1 real-1f),
// and a global static would be overwritten by the last env to load + left
// dangling when that env (e.g. a terminated worker) is torn down — the main
// thread's next `open()` then dereferences a dead Isolate and segfaults
// (B-19a repro). Stored via `SetInstanceData` → freed on env teardown while
// N-API is still valid, so the reference destructs cleanly.
struct AddonData {
  FunctionReference constructor;
};

class ReaderObject : public ObjectWrap<ReaderObject> {
  std::unique_ptr<ShmRing::ReadMapping> mapping;

public:
  static Function Init(Napi::Env env) {
    auto fn = DefineClass(env, "Reader", {});
    env.GetInstanceData<AddonData>()->constructor = Persistent(fn);
    return fn;
  }

  static Object Create(Napi::Env env, const std::string &name) {
    return env.GetInstanceData<AddonData>()->constructor.New(
        {String::New(env, name)});
  }

  ReaderObject(const CallbackInfo &info) : ObjectWrap<ReaderObject>(info) {
    try {
      mapping =
          std::make_unique<ShmRing::ReadMapping>(info[0].As<String>().Utf8Value());
    } catch (const std::exception &e) {
      Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    }
  }

  ShmRing::ReadMapping &core() {
    if (!mapping)
      throw std::runtime_error("SHM reader is closed");
    return *mapping;
  }

  void close() { mapping.reset(); }
};

ReaderObject *unwrapReader(const Value &value) {
  if (!value.IsObject())
    throw TypeError::New(value.Env(), "Expected SHM reader handle");
  return ObjectWrap<ReaderObject>::Unwrap(value.As<Object>());
}

void *bufferData(const Value &value, size_t &bytes) {
  if (value.IsArrayBuffer()) {
    auto ab = value.As<ArrayBuffer>();
    bytes = ab.ByteLength();
    return ab.Data();
  }
  if (value.IsTypedArray()) {
    auto arr = value.As<TypedArray>();
    bytes = arr.ByteLength();
    return static_cast<std::byte *>(arr.ArrayBuffer().Data()) + arr.ByteOffset();
  }
  if (value.IsDataView()) {
    auto view = value.As<DataView>();
    bytes = view.ByteLength();
    return static_cast<std::byte *>(view.ArrayBuffer().Data()) + view.ByteOffset();
  }
  throw TypeError::New(value.Env(), "Destination must be ArrayBuffer or view");
}

Value open(const CallbackInfo &info) {
  try {
    return ReaderObject::Create(info.Env(), info[0].As<String>().Utf8Value());
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}

Value latestSeq(const CallbackInfo &info) {
  try {
    auto &reader = unwrapReader(info[0])->core();
    return BigInt::New(info.Env(), reader.header()->latestSeq.load(
                                       std::memory_order_acquire));
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}

// Shared `Ok` → JS marshaller (readInto + readSeqInto produce the same object).
Object okResult(Napi::Env env, const ShmRing::ReadResult &r) {
  auto result = Object::New(env);
  result.Set("seq", BigInt::New(env, r.seq));
  result.Set("gen", r.gen);
  result.Set("retries", r.retries);
  result.Set("width", r.width);   // v3: active frame size within a max ring
  result.Set("height", r.height);
  result.Set("originX", r.originX); // v4: frame-bound crop origin
  result.Set("originY", r.originY); // (0/0 = uncropped stream)
  // v5: the ACTUAL payload byte length the reader copied — present ONLY when the
  // slot records a nonzero payloadBytes (compression bricks), ABSENT otherwise so
  // the consumer's dim-derived fallback engages (recorder-node.ts `SeqRead.bytes`
  // contract). Marshaled as the JS number property `bytes`.
  if (r.payloadBytes)
    result.Set("bytes", Number::New(env, static_cast<double>(r.payloadBytes)));
  auto meta = Object::New(env);
  meta.Set("tCapture", r.meta.tCapture);
  meta.Set("convertMs", r.meta.convertMs);
  if (r.meta.deviceTimestamp)
    meta.Set("deviceTimestamp", BigInt::New(env, r.meta.deviceTimestamp));
  if (r.meta.systemTimestamp)
    meta.Set("systemTimestamp", BigInt::New(env, r.meta.systemTimestamp));
  result.Set("meta", meta);
  return result;
}

Value readInto(const CallbackInfo &info) {
  try {
    auto env = info.Env();
    auto &reader = unwrapReader(info[0])->core();
    size_t dstBytes = 0;
    void *dst = bufferData(info[1], dstBytes);
    bool lossless = false;
    const uint64_t lastSeq = info[2].IsUndefined() || info[2].IsNull()
                                 ? 0
                                 : info[2].As<BigInt>().Uint64Value(&lossless);

    ShmRing::ReadResult r;
    switch (ShmRing::readLatestInto(reader, dst, dstBytes, lastSeq, r)) {
    case ShmRing::ReadStatus::NoNewFrame:
    case ShmRing::ReadStatus::TornRead:
      return env.Null();
    case ShmRing::ReadStatus::DestTooSmall:
      throw std::runtime_error("Destination buffer is smaller than SHM frame");
    case ShmRing::ReadStatus::Closed: {
      // Explicit pipe-closed signal (C-16) — distinct from `null` (no new
      // frame). The consumer unmaps on this rather than polling a stale ring.
      auto closed = Object::New(env);
      closed.Set("closed", Boolean::New(env, true));
      return closed;
    }
    case ShmRing::ReadStatus::NotYet: // not produced by readLatestInto
    case ShmRing::ReadStatus::Gone:
    case ShmRing::ReadStatus::Ok:
      break;
    }
    return okResult(env, r);
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}

// FIFO-mode read of a SPECIFIC frame (capture-recorder-nodes Phase 0). The
// consumer tracks `wantSeq = lastDelivered + 1` and reads sequentially:
//   { seq, gen, ... }        — Ok: the frame (same shape as readInto)
//   { notYet: true }         — not published yet: short-poll/backoff, retry
//   { gone: true, oldestSeq }— slot recycled: jump to oldestSeq, drop-account
//   { closed: true }         — publisher closed and nothing newer will arrive
//   null                     — torn read (transient): retry the same wantSeq
Value readSeqInto(const CallbackInfo &info) {
  try {
    auto env = info.Env();
    auto &reader = unwrapReader(info[0])->core();
    size_t dstBytes = 0;
    void *dst = bufferData(info[1], dstBytes);
    bool lossless = false;
    const uint64_t wantSeq = info[2].As<BigInt>().Uint64Value(&lossless);

    ShmRing::ReadResult r;
    switch (ShmRing::readSeqInto(reader, wantSeq, dst, dstBytes, r)) {
    case ShmRing::ReadStatus::NoNewFrame: // not produced by readSeqInto
    case ShmRing::ReadStatus::TornRead:
      return env.Null();
    case ShmRing::ReadStatus::DestTooSmall:
      throw std::runtime_error("Destination buffer is smaller than SHM frame");
    case ShmRing::ReadStatus::NotYet: {
      auto o = Object::New(env);
      o.Set("notYet", Boolean::New(env, true));
      return o;
    }
    case ShmRing::ReadStatus::Gone: {
      auto o = Object::New(env);
      o.Set("gone", Boolean::New(env, true));
      o.Set("oldestSeq", BigInt::New(env, r.oldestSeq));
      return o;
    }
    case ShmRing::ReadStatus::Closed: {
      auto closed = Object::New(env);
      closed.Set("closed", Boolean::New(env, true));
      return closed;
    }
    case ShmRing::ReadStatus::Ok:
      break;
    }
    return okResult(env, r);
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}

Value closeReader(const CallbackInfo &info) {
  try {
    unwrapReader(info[0])->close();
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
  }
  return info.Env().Undefined();
}

Object init(Env env, Object exports) {
  // Per-env state (see AddonData) — set BEFORE Init so it can store the
  // constructor. Freed by N-API on env teardown.
  env.SetInstanceData(new AddonData());
  ReaderObject::Init(env);
  exports.Set("open", Function::New(env, open, "open"));
  exports.Set("latestSeq", Function::New(env, latestSeq, "latestSeq"));
  exports.Set("readInto", Function::New(env, readInto, "readInto"));
  exports.Set("readSeqInto", Function::New(env, readSeqInto, "readSeqInto"));
  exports.Set("close", Function::New(env, closeReader, "close"));
  return exports;
}

} // namespace

NODE_API_MODULE(fovea_shm_reader, init);
