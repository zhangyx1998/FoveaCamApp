// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "ShmRing.h"
#include "ShmWrite.h" // shared segment writer (extracted; C-16)

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <fcntl.h>
#include <iomanip>
#include <mutex>
#include <opencv2/core.hpp>
#include <sstream>
#include <stdexcept>
#include <string>
#include <sys/mman.h>
#include <unordered_map>
#include <unistd.h>

#include "napi-helper.h"

namespace ShmRing {
namespace {

uint32_t fnv1a32(const std::string &s) {
  uint32_t h = 2166136261u;
  for (const unsigned char c : s) {
    h ^= c;
    h *= 16777619u;
  }
  return h;
}

std::string segmentName(const std::string &key, uint32_t generation) {
  std::ostringstream ss;
  ss << "/fv." << key << ".g" << generation;
  const auto name = ss.str();
  if (name.size() > 31)
    throw std::runtime_error("SHM segment name exceeds 31 characters: " +
                             name);
  return name;
}

std::string base36(uint32_t value) {
  static constexpr char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (value == 0)
    return "0";
  std::string out;
  while (value > 0) {
    out.push_back(digits[value % 36]);
    value /= 36;
  }
  std::reverse(out.begin(), out.end());
  return out;
}

std::string topicKeyFor(const std::string &topic) {
  static std::mutex mutex;
  static std::unordered_map<std::string, std::string> topicByKey;
  const auto key = base36(fnv1a32(topic));
  std::lock_guard<std::mutex> lock(mutex);
  const auto [it, inserted] = topicByKey.emplace(key, topic);
  if (!inserted && it->second != topic)
    throw std::runtime_error("SHM topic key collision: \"" + topic +
                             "\" and \"" + it->second + "\" both map to " +
                             key);
  return key;
}

std::string errnoMessage(const std::string &action, const std::string &name) {
  return action + " " + name + ": " + std::strerror(errno);
}

std::string manifestPath() {
  const char *tmp = std::getenv("TMPDIR");
  std::ostringstream ss;
  ss << (tmp && tmp[0] ? tmp : "/tmp");
  const std::string base = ss.str();
  if (!base.empty() && base.back() != '/')
    ss << '/';
  ss << "fovea-shm-segments." << getuid();
  return ss.str();
}

void recordSegmentName(const std::string &name) {
  std::ofstream out(manifestPath(), std::ios::app);
  if (out)
    out << name << '\n';
}

bool isFoveaName(const std::string &name) {
  return name.rfind("/fv.", 0) == 0;
}

int unlinkSegment(const std::string &name) {
  if (!isFoveaName(name))
    return 0;
  return shm_unlink(name.c_str()) == 0 ? 1 : 0;
}

int sweepManifest() {
  const auto path = manifestPath();
  std::ifstream in(path);
  int count = 0;
  std::string name;
  while (std::getline(in, name))
    count += unlinkSegment(name);
  std::remove(path.c_str());
  return count;
}

int sweepDirectory(const char *path) {
  DIR *dir = opendir(path);
  if (!dir)
    return 0;
  int count = 0;
  while (auto *entry = readdir(dir)) {
    const std::string file = entry->d_name;
    if (file.rfind("fv.", 0) != 0)
      continue;
    count += unlinkSegment("/" + file);
  }
  closedir(dir);
  return count;
}

std::vector<int> shapeFromValue(const Napi::Value &value) {
  const auto shape = convert<std::vector<int>>(value);
  if (shape.size() != 2)
    throw JS::TypeError(value.Env(), "SHM frame shape must be [height, width]");
  if (shape[0] <= 0 || shape[1] <= 0)
    throw JS::TypeError(value.Env(), "SHM frame dimensions must be positive");
  return shape;
}

// Frame metadata now lives in ShmLayout.h (shared with the read/write TUs);
// keep the `Meta` name locally so the NAPI conversion helpers below are untouched.
using Meta = FrameMeta;

uint64_t optionalBigInt(const Napi::Object &obj, const char *key) {
  if (!obj.Has(key) || obj.Get(key).IsNull() || obj.Get(key).IsUndefined())
    return 0;
  bool lossless = false;
  return obj.Get(key).As<Napi::BigInt>().Uint64Value(&lossless);
}

double optionalNumber(const Napi::Object &obj, const char *key) {
  if (!obj.Has(key) || obj.Get(key).IsNull() || obj.Get(key).IsUndefined())
    return 0;
  return obj.Get(key).As<Napi::Number>().DoubleValue();
}

Meta metaFromValue(const Napi::Value &value) {
  if (!value.IsObject())
    return {};
  const auto obj = value.As<Napi::Object>();
  return {
      .tCapture = optionalNumber(obj, "tCapture"),
      .convertMs = optionalNumber(obj, "convertMs"),
      .deviceTimestamp = optionalBigInt(obj, "deviceTimestamp"),
      .systemTimestamp = optionalBigInt(obj, "systemTimestamp"),
  };
}

// The `Segment` writer is now the shared `ShmRing::Segment` (ShmWrite.h),
// reused by both this live preview writer and the C-16 pipe `Publisher`.

struct SlotNative {
  std::shared_ptr<Segment> segment;
  uint32_t slot = 0;
  std::vector<int> shape;
  int channels = 0;
};

// Per-ENV addon state for core.node's SHM writer classes. The class constructor
// references MUST be per-environment, not process-global statics: when a
// worker_thread loads core.node (the vision worker, for core/Vision) and
// terminates, a global static would be overwritten by the worker's env and left
// dangling → the main thread's next ShmSlot/Writer `Create` dereferences a dead
// Isolate and segfaults — the identical bug fixed for the reader addon in
// B-19b. Stored in core.node's single instance-data slot (nothing else uses
// it); freed by N-API on env teardown while the env is still valid.
struct ShmAddonData {
  Napi::FunctionReference slotCtor;
  Napi::FunctionReference writerCtor;
};

class ShmSlotObject : public Napi::ObjectWrap<ShmSlotObject> {
  SlotNative native;

public:
  static Napi::Function Init(Napi::Env env) {
    auto fn = DefineClass(
        env, "ShmSlot",
        {
            InstanceMethod<&ShmSlotObject::readSnapshot>("readSnapshot"),
            InstanceMethod<&ShmSlotObject::write>("write"),
            InstanceMethod<&ShmSlotObject::copyTo>("copyTo"),
            InstanceMethod<&ShmSlotObject::debugFillPattern>(
                "debugFillPattern"),
        });
    env.GetInstanceData<ShmAddonData>()->slotCtor = Napi::Persistent(fn);
    return fn;
  }

  static Napi::Object Create(Napi::Env env, SlotNative native) {
    auto *heap = new SlotNative(std::move(native));
    return env.GetInstanceData<ShmAddonData>()->slotCtor.New(
        {Napi::External<SlotNative>::New(env, heap)});
  }

  ShmSlotObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ShmSlotObject>(info) {
    auto *heap = info[0].As<Napi::External<SlotNative>>().Data();
    native = std::move(*heap);
    delete heap;
  }

  const SlotNative &value() const { return native; }

  Napi::Value readSnapshot(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    const size_t bytes = native.segment->header()->slotBytes;
#ifdef V8_MEMORY_CAGE
    auto arrayBuffer = Napi::ArrayBuffer::New(env, bytes);
    std::memcpy(arrayBuffer.Data(), native.segment->slotData(native.slot),
                bytes);
#else
    auto keepAlive = new std::shared_ptr<Segment>(native.segment);
    auto arrayBuffer = Napi::ArrayBuffer::New(
        env, native.segment->slotData(native.slot), bytes,
        [](Napi::Env, void *, std::shared_ptr<Segment> *p) { delete p; },
        keepAlive);
#endif
    auto array = Napi::Uint8Array::New(env, bytes, arrayBuffer, 0);
    array.Set("shape", convert(env, native.shape));
    array.Set("channels", native.channels);
    return array;
  }

  // Native memcpy INTO the slot — the cage-safe write path (V13): wrapping
  // external memory as a JS ArrayBuffer is banned under V8_MEMORY_CAGE, but
  // writing shm from native is always fine. `readSnapshot().set()` writes into
  // the cage-local snapshot under Electron and never reaches the slot.
  Napi::Value write(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    try {
      if (!info[0].IsTypedArray())
        throw JS::TypeError(env, "ShmSlot.write expects a TypedArray");
      const auto src = info[0].As<Napi::TypedArray>();
      const size_t len = src.ByteLength();
      const size_t bytes = native.segment->header()->slotBytes;
      if (len != bytes)
        throw JS::Error(env, "ShmSlot.write: source byte length " +
                                 std::to_string(len) + " != slot bytes " +
                                 std::to_string(bytes));
      std::memcpy(native.segment->slotData(native.slot),
                  static_cast<const std::byte *>(src.ArrayBuffer().Data()) +
                      src.ByteOffset(),
                  bytes);
      return env.Undefined();
    }
    JS_EXCEPT(env.Undefined())
  }

  // Native memcpy OUT of the slot into a caller-owned (cage-local) buffer —
  // lets the registry serve `onView` taps from one persistent per-serial
  // buffer instead of allocating a fresh snapshot per frame (V13).
  Napi::Value copyTo(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    try {
      if (!info[0].IsTypedArray())
        throw JS::TypeError(env, "ShmSlot.copyTo expects a TypedArray");
      auto dest = info[0].As<Napi::TypedArray>();
      const size_t bytes = native.segment->header()->slotBytes;
      if (dest.ByteLength() < bytes)
        throw JS::Error(env, "ShmSlot.copyTo: destination too small");
      std::memcpy(static_cast<std::byte *>(dest.ArrayBuffer().Data()) +
                      dest.ByteOffset(),
                  native.segment->slotData(native.slot), bytes);
      return Napi::Number::New(env, static_cast<double>(bytes));
    }
    JS_EXCEPT(env.Undefined())
  }

  Napi::Value debugFillPattern(const Napi::CallbackInfo &info) {
    const int seed = convert<int>(info[0]);
    const uint8_t byte = static_cast<uint8_t>(seed % 251);
    std::memset(native.segment->slotData(native.slot), byte,
                native.segment->header()->slotBytes);
    return info.Env().Undefined();
  }

  static bool Is(const Napi::Value &value) {
    return value.IsObject() &&
           value.As<Napi::Object>().InstanceOf(
               value.Env().GetInstanceData<ShmAddonData>()->slotCtor.Value());
  }

  static const SlotNative &UnwrapValue(const Napi::Value &value) {
    if (!Is(value))
      throw JS::TypeError(value.Env(), "Expected a ShmSlot");
    return Napi::ObjectWrap<ShmSlotObject>::Unwrap(value.As<Napi::Object>())
        ->value();
  }
};


class WriterCore {
  std::mutex mutex;
  std::shared_ptr<Segment> segment;
  std::string key;
  uint32_t generation = 0;
  uint32_t activeSlot = 0;
  std::vector<int> activeShape;
  int activeChannels = 0;
  uint64_t activeSeq = 0;

public:
  explicit WriterCore(std::string key) : key(std::move(key)) {}

  SlotNative nextSlot(const std::vector<int> &shape, int channels) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!segment || activeShape != shape || activeChannels != channels) {
      generation++;
      segment = std::make_shared<Segment>(
          segmentName(key, generation), generation, shape[0], shape[1],
          channels, SLOT_COUNT, recordSegmentName);
      activeShape = shape;
      activeChannels = channels;
    }
    activeSlot = segment->beginSlot();
    return {
        .segment = segment,
        .slot = activeSlot,
        .shape = shape,
        .channels = channels,
    };
  }

  Napi::Object publish(Napi::Env env, const Meta &meta) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!segment)
      throw JS::Error(env, "Cannot publish before nextSlot()");
    activeSeq = segment->publish(activeSlot, meta);
    return descriptor(env, meta);
  }

  Napi::Object descriptor(Napi::Env env, const Meta &meta = {}) const {
    if (!segment)
      throw JS::Error(env, "SHM writer has no active segment");
    auto payload = Napi::Object::New(env);
    payload.Set("shape", convert(env, activeShape));
    payload.Set("channels", activeChannels);
    auto shm = Napi::Object::New(env);
    shm.Set("seg", segment->name);
    shm.Set("gen", segment->generation);
    shm.Set("seq", Napi::BigInt::New(env, activeSeq));
    payload.Set("shm", shm);
    auto m = Napi::Object::New(env);
    if (meta.tCapture > 0)
      m.Set("tCapture", meta.tCapture);
    if (meta.convertMs > 0)
      m.Set("convertMs", meta.convertMs);
    if (meta.deviceTimestamp > 0)
      m.Set("deviceTimestamp", Napi::BigInt::New(env, meta.deviceTimestamp));
    if (meta.systemTimestamp > 0)
      m.Set("systemTimestamp", Napi::BigInt::New(env, meta.systemTimestamp));
    payload.Set("meta", m);
    return payload;
  }

  void close() {
    std::lock_guard<std::mutex> lock(mutex);
    segment.reset();
  }
};

class ShmWriterObject : public Napi::ObjectWrap<ShmWriterObject> {
  std::shared_ptr<WriterCore> core;

public:
  static Napi::Function Init(Napi::Env env) {
    auto fn = DefineClass(
        env, "Writer",
        {
            InstanceMethod<&ShmWriterObject::nextSlot>("nextSlot"),
            InstanceMethod<&ShmWriterObject::publish>("publish"),
            InstanceMethod<&ShmWriterObject::close>("close"),
        });
    env.GetInstanceData<ShmAddonData>()->writerCtor = Napi::Persistent(fn);
    return fn;
  }

  ShmWriterObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ShmWriterObject>(info) {
    core = std::make_shared<WriterCore>(convert<std::string>(info[0]));
  }

  Napi::Value nextSlot(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    try {
      const auto shape = shapeFromValue(info[0]);
      const int channels = convert<int>(info[1]);
      return ShmSlotObject::Create(env, core->nextSlot(shape, channels));
    }
    JS_EXCEPT(env.Undefined())
  }

  Napi::Value publish(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    try {
      return core->publish(env, metaFromValue(optionalArgument(info[0])));
    }
    JS_EXCEPT(env.Undefined())
  }

  Napi::Value close(const Napi::CallbackInfo &info) {
    core->close();
    return info.Env().Undefined();
  }
};


Napi::Value topicKey(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    return Napi::String::New(env, topicKeyFor(convert<std::string>(info[0])));
  }
  JS_EXCEPT(env.Undefined())
}

Napi::Value sweep(const Napi::CallbackInfo &info) {
  const int count = sweepManifest() + sweepDirectory("/dev/shm") +
                    sweepDirectory("/run/shm") + sweepDirectory("/var/run/shm");
  return Napi::Number::New(info.Env(), count);
}

} // namespace

bool isSlot(const Napi::Value &value) { return ShmSlotObject::Is(value); }

WriteTarget writeTarget(const Napi::Value &value) {
  const auto &slot = ShmSlotObject::UnwrapValue(value);
  auto *h = slot.segment->header();
  return {
      .data = slot.segment->slotData(slot.slot),
      .bytes = static_cast<size_t>(h->slotBytes),
      .shape = slot.shape,
      .channels = slot.channels,
      .keepAlive = slot.segment,
  };
}

void exportShmNamespace(Napi::Env env, Napi::Object &exports) {
  // Per-env state (see ShmAddonData) — set BEFORE the class Inits store their
  // constructors. core.node has one instance-data slot; nothing else uses it.
  env.SetInstanceData(new ShmAddonData());
  exports.Set("Writer", ShmWriterObject::Init(env));
  exports.Set("ShmSlot", ShmSlotObject::Init(env));
  exports.Set("topicKey", Napi::Function::New(env, topicKey, "topicKey"));
  exports.Set("sweep", Napi::Function::New(env, sweep, "sweep"));
}

} // namespace ShmRing
