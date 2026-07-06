// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include "ShmRing.h"

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
  ss << "/fv." << std::hex << std::setw(8) << std::setfill('0')
     << fnv1a32(key) << "." << std::dec << generation;
  return ss.str();
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

struct Meta {
  double tCapture = 0;
  double convertMs = 0;
  uint64_t deviceTimestamp = 0;
  uint64_t systemTimestamp = 0;
};

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

class Segment {
  int fd = -1;
  void *mapping = nullptr;
  size_t mappingSize = 0;

public:
  const std::string name;
  const uint32_t generation;

  Segment(std::string name, uint32_t generation, int height, int width,
          int channels)
      : name(std::move(name)), generation(generation) {
    if (channels <= 0)
      throw std::runtime_error("SHM channels must be positive");
    const size_t slotBytes =
        static_cast<size_t>(height) * static_cast<size_t>(width) *
        static_cast<size_t>(channels);
    const size_t dataOffset = alignUp(sizeof(SlotHeader), DATA_ALIGN);
    const size_t slotStride = alignUp(dataOffset + slotBytes, PAGE_ALIGN);
    mappingSize = alignUp(sizeof(SegmentHeader), PAGE_ALIGN) +
                  slotStride * SLOT_COUNT;

    shm_unlink(this->name.c_str());
    fd = shm_open(this->name.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd < 0)
      throw std::runtime_error(errnoMessage("shm_open", this->name));
    recordSegmentName(this->name);
    if (ftruncate(fd, static_cast<off_t>(mappingSize)) != 0) {
      const auto message = errnoMessage("ftruncate", this->name);
      close(fd);
      fd = -1;
      shm_unlink(this->name.c_str());
      throw std::runtime_error(message);
    }
    mapping =
        mmap(nullptr, mappingSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (mapping == MAP_FAILED) {
      const auto message = errnoMessage("mmap", this->name);
      mapping = nullptr;
      close(fd);
      fd = -1;
      shm_unlink(this->name.c_str());
      throw std::runtime_error(message);
    }

    auto *h = header();
    std::memset(h, 0, sizeof(*h));
    std::memcpy(h->magic, MAGIC, sizeof(MAGIC));
    h->layoutVersion = LAYOUT_VERSION;
    h->generation = generation;
    h->width = static_cast<uint32_t>(width);
    h->height = static_cast<uint32_t>(height);
    h->channels = static_cast<uint32_t>(channels);
    h->slotCount = SLOT_COUNT;
    h->slotBytes = slotBytes;
    h->slotStride = slotStride;
    h->dataOffset = dataOffset;
    h->latestSeq.store(0, std::memory_order_release);
    h->latestSlot.store(0, std::memory_order_release);
    for (uint32_t i = 0; i < SLOT_COUNT; ++i)
      slotHeader(i)->seq.store(0, std::memory_order_release);
  }

  ~Segment() {
    if (mapping)
      munmap(mapping, mappingSize);
    if (fd >= 0)
      close(fd);
    shm_unlink(name.c_str());
  }

  SegmentHeader *header() const {
    return reinterpret_cast<SegmentHeader *>(mapping);
  }

  SlotHeader *slotHeader(uint32_t slot) const {
    auto *base = static_cast<std::byte *>(mapping) +
                 alignUp(sizeof(SegmentHeader), PAGE_ALIGN) +
                 header()->slotStride * slot;
    return reinterpret_cast<SlotHeader *>(base);
  }

  void *slotData(uint32_t slot) const {
    return reinterpret_cast<std::byte *>(slotHeader(slot)) + header()->dataOffset;
  }

  uint32_t beginSlot() {
    const uint32_t prev = header()->latestSlot.load(std::memory_order_acquire);
    const uint32_t slot = (prev + 1) % SLOT_COUNT;
    const uint64_t latest = header()->latestSeq.load(std::memory_order_acquire);
    slotHeader(slot)->seq.store(latest * 2 + 1, std::memory_order_release);
    std::atomic_thread_fence(std::memory_order_seq_cst);
    return slot;
  }

  uint64_t publish(uint32_t slot, const Meta &meta) {
    const uint64_t seq = header()->latestSeq.load(std::memory_order_acquire) + 1;
    auto *s = slotHeader(slot);
    s->tCapture = meta.tCapture;
    s->convertMs = meta.convertMs;
    s->deviceTimestamp = meta.deviceTimestamp;
    s->systemTimestamp = meta.systemTimestamp;
    s->seq.store(seq * 2, std::memory_order_release);
    header()->latestSlot.store(slot, std::memory_order_release);
    header()->latestSeq.store(seq, std::memory_order_release);
    return seq;
  }
};

struct SlotNative {
  std::shared_ptr<Segment> segment;
  uint32_t slot = 0;
  std::vector<int> shape;
  int channels = 0;
};

class ShmSlotObject : public Napi::ObjectWrap<ShmSlotObject> {
  static Napi::FunctionReference constructor;
  SlotNative native;

public:
  static Napi::Function Init(Napi::Env env) {
    auto fn = DefineClass(
        env, "ShmSlot",
        {
            InstanceMethod<&ShmSlotObject::debugFillPattern>(
                "debugFillPattern"),
        });
    constructor = Napi::Persistent(fn);
    constructor.SuppressDestruct();
    return fn;
  }

  static Napi::Object Create(Napi::Env env, SlotNative native) {
    auto *heap = new SlotNative(std::move(native));
    return constructor.New({Napi::External<SlotNative>::New(env, heap)});
  }

  ShmSlotObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<ShmSlotObject>(info) {
    auto *heap = info[0].As<Napi::External<SlotNative>>().Data();
    native = std::move(*heap);
    delete heap;
  }

  const SlotNative &value() const { return native; }

  Napi::Value debugFillPattern(const Napi::CallbackInfo &info) {
    const int seed = convert<int>(info[0]);
    const uint8_t byte = static_cast<uint8_t>(seed % 251);
    std::memset(native.segment->slotData(native.slot), byte,
                native.segment->header()->slotBytes);
    return info.Env().Undefined();
  }

  static bool Is(const Napi::Value &value) {
    return value.IsObject() &&
           value.As<Napi::Object>().InstanceOf(constructor.Value());
  }

  static const SlotNative &UnwrapValue(const Napi::Value &value) {
    if (!Is(value))
      throw JS::TypeError(value.Env(), "Expected a ShmSlot");
    return Napi::ObjectWrap<ShmSlotObject>::Unwrap(value.As<Napi::Object>())
        ->value();
  }
};

Napi::FunctionReference ShmSlotObject::constructor;

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
          channels);
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
  static Napi::FunctionReference constructor;
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
    constructor = Napi::Persistent(fn);
    constructor.SuppressDestruct();
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

Napi::FunctionReference ShmWriterObject::constructor;

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
  exports.Set("Writer", ShmWriterObject::Init(env));
  exports.Set("ShmSlot", ShmSlotObject::Init(env));
  exports.Set("sweep", Napi::Function::New(env, sweep, "sweep"));
}

} // namespace ShmRing
