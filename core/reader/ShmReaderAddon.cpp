// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "../include/ShmRing.h"

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <napi.h>
#include <stdexcept>
#include <string>
#include <sys/mman.h>
#include <unistd.h>

using namespace Napi;

namespace {

std::string errnoMessage(const std::string &action, const std::string &name) {
  return action + " " + name + ": " + std::strerror(errno);
}

class Reader {
  int fd = -1;
  void *mapping = nullptr;
  size_t mappingSize = 0;

public:
  explicit Reader(const std::string &name) {
    fd = shm_open(name.c_str(), O_RDONLY, 0);
    if (fd < 0)
      throw std::runtime_error(errnoMessage("shm_open", name));
    auto *firstPage =
        mmap(nullptr, ShmRing::PAGE_ALIGN, PROT_READ, MAP_SHARED, fd, 0);
    if (firstPage == MAP_FAILED) {
      close(fd);
      fd = -1;
      throw std::runtime_error(errnoMessage("mmap header", name));
    }
    auto *h = reinterpret_cast<ShmRing::SegmentHeader *>(firstPage);
    if (std::memcmp(h->magic, ShmRing::MAGIC, sizeof(ShmRing::MAGIC)) != 0 ||
        h->layoutVersion != ShmRing::LAYOUT_VERSION ||
        h->slotCount != ShmRing::SLOT_COUNT) {
      munmap(firstPage, ShmRing::PAGE_ALIGN);
      close(fd);
      fd = -1;
      throw std::runtime_error("Invalid Fovea SHM segment header");
    }
    mappingSize = ShmRing::alignUp(sizeof(ShmRing::SegmentHeader),
                                   ShmRing::PAGE_ALIGN) +
                  h->slotStride * h->slotCount;
    munmap(firstPage, ShmRing::PAGE_ALIGN);
    mapping = mmap(nullptr, mappingSize, PROT_READ, MAP_SHARED, fd, 0);
    if (mapping == MAP_FAILED) {
      mapping = nullptr;
      close(fd);
      fd = -1;
      throw std::runtime_error(errnoMessage("mmap", name));
    }
  }

  ~Reader() { closeHandle(); }

  void closeHandle() {
    if (mapping) {
      munmap(mapping, mappingSize);
      mapping = nullptr;
    }
    if (fd >= 0) {
      close(fd);
      fd = -1;
    }
  }

  ShmRing::SegmentHeader *header() const {
    if (!mapping)
      throw std::runtime_error("SHM reader is closed");
    return reinterpret_cast<ShmRing::SegmentHeader *>(mapping);
  }

  ShmRing::SlotHeader *slotHeader(uint32_t slot) const {
    auto *base = static_cast<std::byte *>(mapping) +
                 ShmRing::alignUp(sizeof(ShmRing::SegmentHeader),
                                  ShmRing::PAGE_ALIGN) +
                 header()->slotStride * slot;
    return reinterpret_cast<ShmRing::SlotHeader *>(base);
  }

  const void *slotData(uint32_t slot) const {
    return reinterpret_cast<const std::byte *>(slotHeader(slot)) +
           header()->dataOffset;
  }
};

class ReaderObject : public ObjectWrap<ReaderObject> {
  static FunctionReference constructor;
  std::unique_ptr<Reader> reader;

public:
  static Function Init(Napi::Env env) {
    auto fn = DefineClass(env, "Reader", {});
    constructor = Persistent(fn);
    constructor.SuppressDestruct();
    return fn;
  }

  static Object Create(Napi::Env env, const std::string &name) {
    return constructor.New({String::New(env, name)});
  }

  ReaderObject(const CallbackInfo &info) : ObjectWrap<ReaderObject>(info) {
    try {
      reader = std::make_unique<Reader>(info[0].As<String>().Utf8Value());
    } catch (const std::exception &e) {
      Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    }
  }

  Reader &core() {
    if (!reader)
      throw std::runtime_error("SHM reader is closed");
    return *reader;
  }

  void close() { reader.reset(); }
};

FunctionReference ReaderObject::constructor;

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
    return BigInt::New(info.Env(),
                       reader.header()->latestSeq.load(std::memory_order_acquire));
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
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
    auto *h = reader.header();
    const uint64_t latest = h->latestSeq.load(std::memory_order_acquire);
    if (latest <= lastSeq)
      return env.Null();
    if (dstBytes < h->slotBytes)
      throw std::runtime_error("Destination buffer is smaller than SHM frame");

    uint32_t retries = 0;
    for (; retries < ShmRing::MAX_READ_RETRIES; ++retries) {
      const uint32_t slot = h->latestSlot.load(std::memory_order_acquire);
      auto *slotHeader = reader.slotHeader(slot);
      const uint64_t before = slotHeader->seq.load(std::memory_order_acquire);
      if ((before & 1) != 0 || before == 0)
        continue;
      std::memcpy(dst, reader.slotData(slot), h->slotBytes);
      const double tCapture = slotHeader->tCapture;
      const double convertMs = slotHeader->convertMs;
      const uint64_t deviceTimestamp = slotHeader->deviceTimestamp;
      const uint64_t systemTimestamp = slotHeader->systemTimestamp;
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint64_t after = slotHeader->seq.load(std::memory_order_acquire);
      if (before != after || (after & 1) != 0)
        continue;

      auto result = Object::New(env);
      const uint64_t seq = after / 2;
      result.Set("seq", BigInt::New(env, seq));
      result.Set("gen", h->generation);
      result.Set("retries", retries);
      auto meta = Object::New(env);
      meta.Set("tCapture", tCapture);
      meta.Set("convertMs", convertMs);
      if (deviceTimestamp)
        meta.Set("deviceTimestamp", BigInt::New(env, deviceTimestamp));
      if (systemTimestamp)
        meta.Set("systemTimestamp", BigInt::New(env, systemTimestamp));
      result.Set("meta", meta);
      return result;
    }
    return env.Null();
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
  ReaderObject::Init(env);
  exports.Set("open", Function::New(env, open, "open"));
  exports.Set("latestSeq", Function::New(env, latestSeq, "latestSeq"));
  exports.Set("readInto", Function::New(env, readInto, "readInto"));
  exports.Set("close", Function::New(env, closeReader, "close"));
  return exports;
}

} // namespace

NODE_API_MODULE(fovea_shm_reader, init);
