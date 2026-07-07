// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// WS1 producer/publisher SHM pipe architecture — scaffold (C-16). See Pipe.h.
// The publisher thread and the (synthetic) producer thread both run in C++,
// off the orchestrator JS loop; the orchestrator brokers only a one-time
// connect handshake. Pixel bytes reach consumers purely through the shared
// segment (reader addon), never per-frame JS.

#include "Pipe.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <map>
#include <sstream>
#include <stdexcept>

namespace Pipe {
namespace {

// Distinct-from-live segment naming: `/fv.p<base36(fnv1a32(id))>.g<gen>` — the
// 'p' marks a pipe segment, keeping it clear of the writer's topic-key names.
uint32_t fnv1a32(const std::string &s) {
  uint32_t h = 2166136261u;
  for (const unsigned char c : s) {
    h ^= c;
    h *= 16777619u;
  }
  return h;
}

std::string base36(uint32_t v) {
  static constexpr char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (v == 0)
    return "0";
  std::string out;
  while (v > 0) {
    out.push_back(digits[v % 36]);
    v /= 36;
  }
  std::reverse(out.begin(), out.end());
  return out;
}

std::string pipeSegmentName(const std::string &id, uint32_t generation) {
  std::ostringstream ss;
  ss << "/fv.p" << base36(fnv1a32(id)) << ".g" << generation;
  const auto name = ss.str();
  if (name.size() > 31)
    throw std::runtime_error("pipe segment name exceeds 31 characters: " + name);
  return name;
}

} // namespace

// ---- Publisher ------------------------------------------------------------

Publisher::Publisher(PipeSpec spec) : spec_(std::move(spec)) {
  if (spec_.bytesPerFrame == 0)
    throw std::runtime_error("pipe bytesPerFrame must be positive");
  shmName_ = pipeSegmentName(spec_.id, /*generation=*/1);
  segment_ = std::make_unique<ShmRing::Segment>(
      shmName_, /*generation=*/1, static_cast<int>(spec_.height),
      static_cast<int>(spec_.width), static_cast<int>(spec_.channels),
      spec_.ringDepth, /*onCreate=*/nullptr,
      /*slotBytesOverride=*/spec_.bytesPerFrame);
  pending_.resize(spec_.bytesPerFrame);
}

Publisher::~Publisher() { stopThread(); }

void Publisher::offer(const FrameView &frame) {
  if (frame.bytes != spec_.bytesPerFrame || frame.data == nullptr)
    return; // wrong-sized frame: drop (never throw into the producer)
  {
    std::lock_guard<std::mutex> lock(mutex_);
    if (closed_)
      return;
    std::memcpy(pending_.data(), frame.data, spec_.bytesPerFrame);
    pendingMeta_ = frame.meta;
    hasPending_ = true;
  }
  cv_.notify_one();
}

uint32_t Publisher::connect() {
  const uint32_t prev = refcount_.fetch_add(1, std::memory_order_acq_rel);
  if (prev == 0)
    startThread();
  return prev + 1;
}

uint32_t Publisher::disconnect() {
  uint32_t cur = refcount_.load(std::memory_order_acquire);
  if (cur == 0)
    return 0;
  const uint32_t next = refcount_.fetch_sub(1, std::memory_order_acq_rel) - 1;
  if (next == 0)
    stopThread(); // pause production; segment stays mapped/advertised
  return next;
}

void Publisher::close() {
  stopThread();
  std::lock_guard<std::mutex> lock(mutex_);
  closed_ = true;
  if (segment_)
    segment_->setState(ShmRing::PipeState::CLOSED); // release-ordered signal
}

void Publisher::startThread() {
  if (thread_.joinable())
    return;
  stop_.store(false, std::memory_order_release);
  thread_ = std::thread(&Publisher::run, this);
}

void Publisher::stopThread() {
  if (!thread_.joinable())
    return;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    stop_.store(true, std::memory_order_release);
  }
  cv_.notify_all();
  thread_.join();
}

void Publisher::run() {
  running_.store(true, std::memory_order_release);
  std::vector<uint8_t> frame(spec_.bytesPerFrame);
  for (;;) {
    ShmRing::FrameMeta meta;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      cv_.wait(lock, [this] {
        return hasPending_ || stop_.load(std::memory_order_acquire);
      });
      if (stop_.load(std::memory_order_acquire))
        break;
      std::memcpy(frame.data(), pending_.data(), spec_.bytesPerFrame);
      meta = pendingMeta_;
      hasPending_ = false;
    }
    // Seqlock-write the latest frame OUTSIDE the lock (the whole point: the
    // per-frame memcpy + publish runs on this thread, never the JS loop).
    const uint32_t slot = segment_->beginSlot();
    std::memcpy(segment_->slotData(slot), frame.data(), spec_.bytesPerFrame);
    segment_->publish(slot, meta);
  }
  running_.store(false, std::memory_order_release);
}

// ---- SyntheticProducer ----------------------------------------------------

SyntheticProducer::SyntheticProducer(PipeSpec spec, double fps, uint8_t seed)
    : spec_(std::move(spec)), fps_(fps > 0 ? fps : 60.0), seed_(seed) {}

SyntheticProducer::~SyntheticProducer() { stop(); }

void SyntheticProducer::start(Publisher &sink) {
  if (thread_.joinable())
    return;
  stop_.store(false, std::memory_order_release);
  thread_ = std::thread([this, &sink] {
    std::vector<uint8_t> buf(spec_.bytesPerFrame);
    const auto period = std::chrono::duration<double, std::milli>(1000.0 / fps_);
    for (uint64_t i = 0; !stop_.load(std::memory_order_acquire); ++i) {
      std::memset(buf.data(), static_cast<int>((seed_ + i) & 0xff),
                  buf.size());
      FrameView view;
      view.data = buf.data();
      view.bytes = buf.size();
      view.meta.tCapture = static_cast<double>(i);
      sink.offer(view);
      std::this_thread::sleep_for(period);
    }
  });
}

void SyntheticProducer::stop() {
  stop_.store(true, std::memory_order_release);
  if (thread_.joinable())
    thread_.join();
}

// ---- Broker (PipeHub) -----------------------------------------------------

namespace {

struct PipeEntry {
  PipeSpec spec;
  std::unique_ptr<Publisher> publisher;
  std::unique_ptr<SyntheticProducer> producer;
};

class Hub {
  std::mutex m_;
  std::map<std::string, PipeEntry> pipes_;

public:
  static Hub &instance() {
    static Hub hub;
    return hub;
  }

  void advertise(const PipeSpec &spec) {
    std::lock_guard<std::mutex> lock(m_);
    if (pipes_.count(spec.id))
      return; // idempotent
    PipeEntry entry;
    entry.spec = spec;
    entry.publisher = std::make_unique<Publisher>(spec);
    pipes_.emplace(spec.id, std::move(entry));
  }

  Publisher &publisher(const std::string &id) {
    std::lock_guard<std::mutex> lock(m_);
    auto it = pipes_.find(id);
    if (it == pipes_.end())
      throw std::runtime_error("unknown pipe id: " + id);
    return *it->second.publisher;
  }

  void attachSynthetic(const std::string &id, double fps, uint8_t seed) {
    std::lock_guard<std::mutex> lock(m_);
    auto it = pipes_.find(id);
    if (it == pipes_.end())
      throw std::runtime_error("unknown pipe id: " + id);
    if (it->second.producer)
      return;
    it->second.producer =
        std::make_unique<SyntheticProducer>(it->second.spec, fps, seed);
    it->second.producer->start(*it->second.publisher);
  }

  void drop(const std::string &id) {
    std::unique_ptr<PipeEntry> entry;
    {
      std::lock_guard<std::mutex> lock(m_);
      auto it = pipes_.find(id);
      if (it == pipes_.end())
        return;
      entry = std::make_unique<PipeEntry>(std::move(it->second));
      pipes_.erase(it);
    }
    // Tear down producer first (stops offering), then publisher (unmaps/unlinks).
    if (entry->producer)
      entry->producer->stop();
    if (entry->publisher)
      entry->publisher->close();
  }
};

// ---- N-API surface --------------------------------------------------------

using namespace Napi;

uint32_t u32(const Object &o, const char *k, uint32_t fallback = 0) {
  if (!o.Has(k) || o.Get(k).IsUndefined() || o.Get(k).IsNull())
    return fallback;
  return static_cast<uint32_t>(o.Get(k).As<Number>().Uint32Value());
}

std::string str(const Object &o, const char *k) {
  if (!o.Has(k) || o.Get(k).IsUndefined() || o.Get(k).IsNull())
    return {};
  return o.Get(k).As<String>().Utf8Value();
}

PipeSpec specFromValue(const Value &value) {
  const auto o = value.As<Object>();
  PipeSpec spec;
  spec.id = str(o, "id");
  spec.pixelFormat = str(o, "pixelFormat");
  spec.dtype = str(o, "dtype");
  spec.width = u32(o, "width");
  spec.height = u32(o, "height");
  spec.channels = u32(o, "channels", 1);
  spec.stride = u32(o, "stride");
  bool lossless = false;
  spec.bytesPerFrame =
      o.Has("bytesPerFrame")
          ? o.Get("bytesPerFrame").As<Number>().Int64Value()
          : 0;
  (void)lossless;
  spec.ringDepth = u32(o, "ringDepth", ShmRing::SLOT_COUNT);
  if (spec.id.empty())
    throw std::runtime_error("PipeSpec.id required");
  return spec;
}

Object specToObject(Env env, const PipeSpec &s) {
  auto o = Object::New(env);
  o.Set("id", String::New(env, s.id));
  o.Set("pixelFormat", String::New(env, s.pixelFormat));
  o.Set("dtype", String::New(env, s.dtype));
  o.Set("width", Number::New(env, s.width));
  o.Set("height", Number::New(env, s.height));
  o.Set("channels", Number::New(env, s.channels));
  o.Set("stride", Number::New(env, s.stride));
  o.Set("bytesPerFrame", Number::New(env, static_cast<double>(s.bytesPerFrame)));
  o.Set("ringDepth", Number::New(env, s.ringDepth));
  return o;
}

Value advertise(const CallbackInfo &info) {
  try {
    Hub::instance().advertise(specFromValue(info[0]));
    return info.Env().Undefined();
  } catch (const std::exception &e) {
    Error::New(info.Env(), e.what()).ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
}

Value connect(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    auto &pub = Hub::instance().publisher(id);
    pub.connect();
    auto handle = Object::New(env);
    handle.Set("pipeId", String::New(env, id));
    handle.Set("shmName", String::New(env, pub.shmName()));
    handle.Set("spec", specToObject(env, pub.spec()));
    handle.Set("ringDepth", Number::New(env, pub.spec().ringDepth));
    auto layout = Object::New(env);
    layout.Set("layoutVersion", Number::New(env, ShmRing::LAYOUT_VERSION));
    layout.Set("magic", String::New(env, std::string(ShmRing::MAGIC, 7)));
    handle.Set("headerLayout", layout);
    return handle;
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value disconnect(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    return Number::New(env, Hub::instance().publisher(id).disconnect());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value consumers(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    return Number::New(env, Hub::instance().publisher(id).consumers());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value close(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    Hub::instance().publisher(info[0].As<String>().Utf8Value()).close();
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Value attachSynthetic(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    const double fps =
        info[1].IsNumber() ? info[1].As<Number>().DoubleValue() : 60.0;
    const uint8_t seed = info[2].IsNumber()
                             ? static_cast<uint8_t>(info[2].As<Number>().Uint32Value())
                             : 0;
    Hub::instance().attachSynthetic(id, fps, seed);
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Value drop(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    Hub::instance().drop(info[0].As<String>().Utf8Value());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

} // namespace

void exportPipeNamespace(Napi::Env env, Napi::Object &exports) {
  exports.Set("advertise", Function::New(env, advertise, "advertise"));
  exports.Set("connect", Function::New(env, connect, "connect"));
  exports.Set("disconnect", Function::New(env, disconnect, "disconnect"));
  exports.Set("consumers", Function::New(env, consumers, "consumers"));
  exports.Set("close", Function::New(env, close, "close"));
  exports.Set("attachSynthetic",
              Function::New(env, attachSynthetic, "attachSynthetic"));
  exports.Set("drop", Function::New(env, drop, "drop"));
}

} // namespace Pipe
