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

int64_t nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch())
      .count();
}

} // namespace

// ---- Publisher (collapsed — offer writes on the producer thread) ----------

Publisher::Publisher(PipeSpec spec, uint32_t epoch)
    : spec_(std::move(spec)),
      meter_(std::string("pipe:") + spec_.id, {"frame"}, {"shm"}, nowMs()) {
  if (spec_.bytesPerFrame == 0)
    throw std::runtime_error("pipe bytesPerFrame must be positive");
  // Resolve the ring capacity: the MAX footprint (defaults to nominal).
  if (spec_.maxWidth == 0) spec_.maxWidth = spec_.width;
  if (spec_.maxHeight == 0) spec_.maxHeight = spec_.height;
  if (spec_.maxBytes == 0) spec_.maxBytes = spec_.bytesPerFrame;
  shmName_ = pipeSegmentName(spec_.id, epoch);
  // The segment header carries the MAX dims (ring capacity); each frame's
  // active w/h rides the slot header (v3).
  segment_ = std::make_unique<ShmRing::Segment>(
      shmName_, epoch, static_cast<int>(spec_.maxHeight),
      static_cast<int>(spec_.maxWidth), static_cast<int>(spec_.channels),
      spec_.ringDepth, /*onCreate=*/nullptr,
      /*slotBytesOverride=*/spec_.maxBytes);
}

void Publisher::offer(const void *data, const FrameInfo &info,
                      const ShmRing::FrameMeta &meta) {
  const int64_t now = nowMs();
  // The producer thread is the meter's SOLE writer: record the arrival. (Convert
  // cost lives in B's converter meter now — C-21; attributing it here too would
  // double-count. This meter's busy = the SHM WRITE below.)
  meter_.ingest("frame", now);

  // Element size (bytes per channel; 1 for U8, 4 for CV_32FC1) folds into the
  // tight-packed byte math so non-U8 mats (Disparity32F) publish uncorrupted.
  const size_t elemBytes = info.bytesPerElement ? info.bytesPerElement : 1;
  const size_t activeBytes =
      static_cast<size_t>(info.width) * info.height * info.channels * elemBytes;
  if (data == nullptr || info.channels != spec_.channels ||
      info.width > spec_.maxWidth || info.height > spec_.maxHeight ||
      activeBytes > spec_.maxBytes) {
    meter_.drop(); // over the max footprint → the pipe must be re-advertised
    return;
  }
  // Paused (no consumers) or closed → no ring write, but arrivals stay metered.
  // (Defensive net, Q6: the consumer gate detaches the producer at refcount 0,
  // so in practice offer() isn't even called then.)
  if (closed_.load(std::memory_order_acquire) ||
      refcount_.load(std::memory_order_acquire) == 0)
    return;

  // Seqlock-write the ACTIVE frame tight-packed into the head of the max slot,
  // row-by-row (honor stride), ON the producer's thread. The consumer reads the
  // active w/h from the slot header and consumes only `activeBytes`.
  const auto writeStart = std::chrono::steady_clock::now();
  const uint32_t slot = segment_->beginSlot();
  auto *dst = static_cast<uint8_t *>(segment_->slotData(slot));
  const auto *src = static_cast<const uint8_t *>(data);
  const size_t rowBytes =
      static_cast<size_t>(info.width) * info.channels * elemBytes;
  const size_t stride = info.stride ? info.stride : rowBytes;
  for (uint32_t y = 0; y < info.height; ++y)
    std::memcpy(dst + static_cast<size_t>(y) * rowBytes,
                src + static_cast<size_t>(y) * stride, rowBytes);
  segment_->publish(slot, meta, info.width, info.height, info.originX,
                    info.originY); // v4: frame-bound crop origin
  meter_.emit("shm", now);
  // C-24 item 3: exact per-edge byte flow (variable-size fovea frames make
  // rate × nominal-bytes wrong; count what was actually ring-written).
  bytesTotal_.fetch_add(activeBytes, std::memory_order_relaxed);
  // Attribute the actual write (memcpy) time to busy — the pipe's own cost.
  meter_.addBusy(std::chrono::duration<double, std::milli>(
                     std::chrono::steady_clock::now() - writeStart)
                     .count());
}

uint32_t Publisher::connect() {
  const uint32_t n = refcount_.fetch_add(1, std::memory_order_acq_rel) + 1;
  if (n == 1 && gate_)
    gate_(true); // 0→1 edge: wake the converter
  return n;
}

uint32_t Publisher::disconnect() {
  uint32_t cur = refcount_.load(std::memory_order_acquire);
  if (cur == 0)
    return 0;
  const uint32_t next = refcount_.fetch_sub(1, std::memory_order_acq_rel) - 1;
  if (next == 0 && gate_)
    gate_(false); // →0 edge: park the converter
  return next;
}

void Publisher::setConsumerGate(ConsumerGate gate) {
  gate_ = std::move(gate);
  // Reconcile: a consumer may have connected before the gate was registered.
  if (gate_)
    gate_(refcount_.load(std::memory_order_acquire) > 0);
}

void Publisher::close() {
  closed_.store(true, std::memory_order_release);
  if (segment_)
    segment_->setState(ShmRing::PipeState::CLOSED); // release-ordered signal
}

Meter::Snapshot Publisher::probe() const { return meter_.probe(nowMs()); }

// ---- SyntheticProducer (test driver — offers on its own thread) -----------

SyntheticProducer::SyntheticProducer(PipeSpec spec, double fps, uint8_t seed)
    : spec_(std::move(spec)), fps_(fps > 0 ? fps : 60.0), seed_(seed) {}

SyntheticProducer::~SyntheticProducer() { stop(); }

void SyntheticProducer::start(FrameSink &sink) {
  if (thread_.joinable())
    return;
  stop_.store(false, std::memory_order_release);
  thread_ = std::thread([this, &sink] {
    std::vector<uint8_t> buf(spec_.bytesPerFrame);
    const auto period = std::chrono::duration<double, std::milli>(1000.0 / fps_);
    const FrameInfo info{spec_.width, spec_.height, spec_.channels,
                         spec_.width * spec_.channels, spec_.bytesPerFrame};
    for (uint64_t i = 0; !stop_.load(std::memory_order_acquire); ++i) {
      std::memset(buf.data(), static_cast<int>((seed_ + i) & 0xff), buf.size());
      ShmRing::FrameMeta meta;
      meta.tCapture = static_cast<double>(i);
      sink.offer(buf.data(), info, meta);
      std::this_thread::sleep_for(period);
      // A stall injection lengthens the gap before the NEXT offer.
      const double stall = stallMs_.exchange(0, std::memory_order_acq_rel);
      if (stall > 0)
        std::this_thread::sleep_for(
            std::chrono::duration<double, std::milli>(stall));
    }
  });
}

void SyntheticProducer::stop() {
  stop_.store(true, std::memory_order_release);
  if (thread_.joinable())
    thread_.join();
}

// ---- Broker (PipeHub) -----------------------------------------------------

PipeHub &PipeHub::instance() {
  static PipeHub hub;
  return hub;
}

uint32_t PipeHub::advertise(const PipeSpec &spec) {
  std::lock_guard<std::mutex> lock(m_);
  if (pipes_.count(spec.id))
    return epochs_[spec.id]; // idempotent for a live id
  // First advertise, or reuse after a drop: bump the per-id epoch → new segment
  // name, so a stale consumer on the old segment sees CLOSED (never binds the
  // reused id). `epochs_` persists across drop.
  const uint32_t epoch = ++epochs_[spec.id];
  PipeEntry entry;
  entry.spec = spec;
  entry.publisher = std::make_unique<Publisher>(spec, epoch);
  pipes_.emplace(spec.id, std::move(entry));
  return epoch;
}

std::vector<std::pair<std::string, Meter::Snapshot>> PipeHub::probeAll() {
  std::lock_guard<std::mutex> lock(m_);
  std::vector<std::pair<std::string, Meter::Snapshot>> out;
  for (auto &kv : pipes_)
    out.push_back({kv.first, kv.second.publisher->probe()});
  return out;
}

std::vector<PipeHub::ListEntry> PipeHub::list() {
  std::lock_guard<std::mutex> lock(m_);
  std::vector<ListEntry> out;
  out.reserve(pipes_.size());
  for (auto &kv : pipes_) {
    auto &p = *kv.second.publisher;
    out.push_back({kv.first, p.spec(), p.epoch(), p.consumers(), p.isClosed(),
                   p.bytesTotal()});
  }
  return out;
}

Publisher &PipeHub::publisher(const std::string &id) {
  std::lock_guard<std::mutex> lock(m_);
  auto it = pipes_.find(id);
  if (it == pipes_.end())
    throw std::runtime_error("unknown pipe id: " + id);
  return *it->second.publisher;
}

FrameSink *PipeHub::sink(const std::string &id) {
  std::lock_guard<std::mutex> lock(m_);
  auto it = pipes_.find(id);
  return it == pipes_.end() ? nullptr : it->second.publisher.get();
}

void PipeHub::setConsumerGate(const std::string &id, ConsumerGate gate) {
  Publisher *pub = nullptr;
  {
    std::lock_guard<std::mutex> lock(m_);
    auto it = pipes_.find(id);
    if (it == pipes_.end())
      throw std::runtime_error("unknown pipe id: " + id);
    pub = it->second.publisher.get();
  }
  // Fire OUTSIDE the hub lock — the gate calls into B's Stream (subscribe); the
  // hub lock must never be held across it. Safe: hub mutation is NAPI-thread.
  pub->setConsumerGate(std::move(gate));
}

void PipeHub::attachSynthetic(const std::string &id, double fps, uint8_t seed) {
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

void PipeHub::injectStall(const std::string &id, double ms) {
  std::lock_guard<std::mutex> lock(m_);
  auto it = pipes_.find(id);
  if (it != pipes_.end() && it->second.producer)
    it->second.producer->injectStall(ms);
}

void PipeHub::drop(const std::string &id) {
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

namespace {

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
  spec.ringDepth = u32(o, "ringDepth", ShmRing::SLOT_COUNT);
  spec.maxWidth = u32(o, "maxWidth");
  spec.maxHeight = u32(o, "maxHeight");
  spec.maxBytes =
      o.Has("maxBytes") ? o.Get("maxBytes").As<Number>().Int64Value() : 0;
  (void)lossless;
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
  o.Set("maxWidth", Number::New(env, s.maxWidth));
  o.Set("maxHeight", Number::New(env, s.maxHeight));
  o.Set("maxBytes", Number::New(env, static_cast<double>(s.maxBytes)));
  return o;
}

// Native meter snapshot → the JS `WorkloadSnapshot` shape (C-18) so the
// orchestrator folds a native producer stream into `perfSnapshot.workloads`
// and the profiler renders it identically to a JS workload.
Object streamStatObject(Env env, const Meter::StreamStat &s) {
  auto o = Object::New(env);
  o.Set("count", Number::New(env, static_cast<double>(s.count)));
  o.Set("ratePerSec", Number::New(env, s.ratePerSec));
  o.Set("maxIntervalMs", Number::New(env, s.maxIntervalMs));
  return o;
}

Object snapshotToObject(Env env, const Meter::Snapshot &s) {
  auto o = Object::New(env);
  o.Set("name", String::New(env, s.name));
  auto window = Object::New(env);
  window.Set("startedAt", Number::New(env, static_cast<double>(s.startedAtMs)));
  window.Set("snapshotAt", Number::New(env, static_cast<double>(s.snapshotAtMs)));
  window.Set("uptimeMs", Number::New(env, static_cast<double>(s.uptimeMs)));
  o.Set("window", window);
  o.Set("utilization", Number::New(env, s.utilization));
  o.Set("busyMs", Number::New(env, s.busyMs));
  auto inputs = Object::New(env);
  for (const auto &[name, st] : s.inputs)
    inputs.Set(name, streamStatObject(env, st));
  o.Set("inputs", inputs);
  auto outputs = Object::New(env);
  for (const auto &[name, st] : s.outputs)
    outputs.Set(name, streamStatObject(env, st));
  o.Set("outputs", outputs);
  auto drops = Object::New(env);
  const double uptimeSec = static_cast<double>(s.uptimeMs) / 1000.0;
  drops.Set("total", Number::New(env, static_cast<double>(s.dropTotal)));
  drops.Set("ratePerSec",
            Number::New(env, static_cast<double>(s.dropTotal) / uptimeSec));
  drops.Set("byReason", Object::New(env));
  o.Set("drops", drops);
  return o;
}

Value advertise(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    return Number::New(env,
                       PipeHub::instance().advertise(specFromValue(info[0])));
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value connect(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    auto &pub = PipeHub::instance().publisher(id);
    pub.connect();
    auto handle = Object::New(env);
    handle.Set("pipeId", String::New(env, id));
    handle.Set("shmName", String::New(env, pub.shmName()));
    handle.Set("spec", specToObject(env, pub.spec()));
    handle.Set("ringDepth", Number::New(env, pub.spec().ringDepth));
    handle.Set("epoch", Number::New(env, pub.epoch())); // reuse-safe identity
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
    return Number::New(env, PipeHub::instance().publisher(id).disconnect());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value consumers(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    return Number::New(env, PipeHub::instance().publisher(id).consumers());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value close(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    PipeHub::instance().publisher(info[0].As<String>().Utf8Value()).close();
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
    PipeHub::instance().attachSynthetic(id, fps, seed);
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Value drop(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    PipeHub::instance().drop(info[0].As<String>().Utf8Value());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// Out-of-loop probe of a pipe's native producer meter → WorkloadSnapshot shape.
Value probe(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    return snapshotToObject(env, PipeHub::instance().publisher(id).probe());
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

Value injectStall(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    const double ms = info[1].IsNumber() ? info[1].As<Number>().DoubleValue() : 0;
    PipeHub::instance().injectStall(id, ms);
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// Test hook (C-20): offer one synthetic frame of ACTIVE size w×h (filled with
// `byte`) into a live pipe, on the calling thread — drives the resize/reuse
// tests without the synthetic producer thread.
Value offerFrame(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    const uint32_t w = info[1].As<Number>().Uint32Value();
    const uint32_t h = info[2].As<Number>().Uint32Value();
    const uint8_t byte =
        info[3].IsNumber() ? static_cast<uint8_t>(info[3].As<Number>().Uint32Value())
                           : 0;
    auto &pub = PipeHub::instance().publisher(id);
    const uint32_t channels = pub.spec().channels;
    const size_t bytes = static_cast<size_t>(w) * h * channels;
    std::vector<uint8_t> buf(bytes, byte);
    FrameInfo fi{w, h, channels, w * channels, bytes};
    ShmRing::FrameMeta meta;
    pub.offer(buf.data(), fi, meta);
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

// Test hooks (C-21): install a consumer gate that records each fire, and read
// the recorded log — proves the gate fires immediately-on-register (current
// state) + on 0↔1 edges only. B installs the REAL gate in attachCameraPipe.
std::map<std::string, std::vector<bool>> g_testGateLog;

Value installTestGate(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    const auto id = info[0].As<String>().Utf8Value();
    g_testGateLog[id].clear();
    PipeHub::instance().setConsumerGate(id, [id](bool active) {
      g_testGateLog[id].push_back(active);
    });
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Value testGateLog(const CallbackInfo &info) {
  auto env = info.Env();
  const auto id = info[0].As<String>().Utf8Value();
  const auto &log = g_testGateLog[id];
  auto arr = Array::New(env, log.size());
  for (size_t i = 0; i < log.size(); ++i)
    arr.Set(static_cast<uint32_t>(i), Boolean::New(env, log[i]));
  return arr;
}

// Enumerate every ADVERTISED pipe without connecting (C-24 item 2): identity +
// spec + epoch + consumer refcount + closed + exact bytesTotal — the graph
// topology's discovery + per-edge byte-flow source.
Value list(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    auto entries = PipeHub::instance().list();
    auto arr = Array::New(env, entries.size());
    uint32_t i = 0;
    for (const auto &e : entries) {
      auto o = Object::New(env);
      o.Set("id", String::New(env, e.id));
      o.Set("spec", specToObject(env, e.spec));
      o.Set("epoch", Number::New(env, e.epoch));
      o.Set("consumers", Number::New(env, e.consumers));
      o.Set("closed", Boolean::New(env, e.closed));
      o.Set("bytesTotal", Number::New(env, static_cast<double>(e.bytesTotal)));
      arr.Set(i++, o);
    }
    return arr;
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
}

// Probe EVERY live pipe → {[pipeId]: WorkloadSnapshot}. Dropped pipes are
// absent (no stale workload rows under churn) — the orchestrator folds this
// straight into `perfSnapshot.workloads`.
Value probeAll(const CallbackInfo &info) {
  auto env = info.Env();
  try {
    auto out = Object::New(env);
    for (const auto &[id, snap] : PipeHub::instance().probeAll())
      out.Set(id, snapshotToObject(env, snap));
    return out;
  } catch (const std::exception &e) {
    Error::New(env, e.what()).ThrowAsJavaScriptException();
    return env.Undefined();
  }
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
  exports.Set("injectStall", Function::New(env, injectStall, "injectStall"));
  exports.Set("probe", Function::New(env, probe, "probe"));
  exports.Set("probeAll", Function::New(env, probeAll, "probeAll"));
  exports.Set("list", Function::New(env, list, "list"));
  exports.Set("offerFrame", Function::New(env, offerFrame, "offerFrame"));
  exports.Set("installTestGate",
              Function::New(env, installTestGate, "installTestGate"));
  exports.Set("testGateLog", Function::New(env, testGateLog, "testGateLog"));
  exports.Set("drop", Function::New(env, drop, "drop"));
}

} // namespace Pipe
