// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// multi-fovea-recording rulings 9 + 10: the COMPRESSION brick. A two-ended
// native node that consumes ANY advertised frame pipe and republishes each
// frame INTRA-FRAME compressed (every output frame decompresses alone — the
// container-seekability ruling) into an output pipe whose advert carries the
// source format with a `/codec` suffix (`BayerRG12p/zlib`).
//
// TRANSPORT (why not the ScaleStream in-process tap): the PRIMARY compression
// input is the packed `camera/<serial>/raw12p` stream, which exists ONLY as an
// SHM pipe (a pre-Frame ArvBuffer tap — there is no in-process ConvertedFrame
// producer carrying the verbatim packed payload). So this brick reads its source
// via the shared SHM READ path (`ShmRead.h` `readSeqInto`, FIFO — ordered and
// lossless-within-a-ring, exactly the recorder's discipline) on its OWN native
// thread, and forwards the SOURCE frame's identity (width/height/origin +
// device/system timestamps from the source slot meta). It works for any frame
// pipe (raw12p, raw, convert, undistort, …) uniformly. The NAPI surface /
// registry / consumer gate / meter / topology row mirror ScaleStream + RawPipe.
//
// DEMAND: the output (compress) pipe's consumer refcount gates the brick (C-21).
// On the 0→1 edge the gate CONNECTS the source pipe (driving the source
// producer's own gate) and spawns the runner thread; on →0 it joins the runner
// and disconnects the source. All connect/disconnect + registry mutation stay on
// the NAPI thread (the gate fires there); the runner touches only its private
// ReadMapping + the output FrameSink.
//
// zlib (system libz, no new dep): per-frame `compress2` at a construction-time
// level (default `Z_DEFAULT_COMPRESSION`). The blob is published verbatim via
// the v5 opaque-payload `offer()` path (`FrameInfo.payloadBytes` = the exact
// compressed length; the ring records it so the reader copies exactly that many
// bytes). Offline readers split pixelFormat on `/`, decompress the suffix chain
// right-to-left, then interpret the base format.

#include <atomic>
#include <chrono>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <zlib.h>

#include <Topology.h>
#include <napi-helper.h>

#include "../../include/ShmRead.h" // ReadMapping, readSeqInto (libc-only read TU)
#include "ConverterStream.h" // converterNowMs, meterSnapshotToJs, Pipe::*, Meter

using namespace Napi;

namespace Arv {

// ---- the runner: a private native thread FIFO-reading the source SHM ring ----
// Owns its ReadMapping + scratch buffers; touches nothing NAPI/registry. Created
// while the output pipe has ≥1 consumer, joined when it drops to 0.
class CompressRunner {
public:
  CompressRunner(std::string sourceShmName, Pipe::FrameSink *sink,
                 size_t srcSlotBytes, uint32_t srcChannels,
                 size_t srcBytesPerPixel, size_t outMaxBytes, int level,
                 Meter::ThreadMeter *meter)
      : sourceShmName_(std::move(sourceShmName)), sink_(sink),
        srcSlotBytes_(srcSlotBytes), srcChannels_(srcChannels),
        srcBytesPerPixel_(srcBytesPerPixel ? srcBytesPerPixel : 1),
        outMaxBytes_(outMaxBytes), level_(level), meter_(meter) {
    src_.resize(srcSlotBytes_ ? srcSlotBytes_ : 1);
    // Worst-case compressed size for a full source slot (compress2 never writes
    // past this). The output pipe's advert must size maxBytes ≥ this; an
    // undersize makes offer() drop the (near-incompressible) frame.
    dst_.resize(static_cast<size_t>(::compressBound(
        static_cast<uLong>(src_.size()))));
    thread_ = std::thread([this] { run(); });
  }
  ~CompressRunner() {
    stop_.store(true, std::memory_order_release);
    if (thread_.joinable())
      thread_.join();
  }
  CompressRunner(const CompressRunner &) = delete;
  CompressRunner &operator=(const CompressRunner &) = delete;

private:
  void run() {
    std::unique_ptr<ShmRing::ReadMapping> map;
    try {
      map = std::make_unique<ShmRing::ReadMapping>(sourceShmName_);
    } catch (...) {
      return; // source segment vanished/never mapped — park (re-attach re-opens)
    }
    uint64_t want = 1; // FIFO cursor: lastDelivered + 1 (ShmWrite round-robin)
    while (!stop_.load(std::memory_order_acquire)) {
      ShmRing::ReadResult r;
      const auto st =
          ShmRing::readSeqInto(*map, want, src_.data(), src_.size(), r);
      switch (st) {
      case ShmRing::ReadStatus::Ok: {
        // Active source bytes: the slot's own payloadBytes when it records one
        // (a chained/opaque source), else the dim-derived active length
        // (width*height*bytes-per-pixel). Clamp to the buffer for safety.
        size_t srcBytes = r.payloadBytes
                              ? static_cast<size_t>(r.payloadBytes)
                              : static_cast<size_t>(r.width) * r.height *
                                    srcBytesPerPixel_;
        if (srcBytes > src_.size())
          srcBytes = src_.size();
        compressAndOffer(srcBytes, r);
        ++want;
        break;
      }
      case ShmRing::ReadStatus::NotYet:
        std::this_thread::sleep_for(std::chrono::milliseconds(1)); // short poll
        break;
      case ShmRing::ReadStatus::Gone:
        // Lagged a full ring: account the gap as drops and jump to the oldest
        // still-live seq (exactly the recorder's Gone handling).
        if (meter_ && r.oldestSeq > want)
          meter_->drop(static_cast<uint32_t>(r.oldestSeq - want));
        want = r.oldestSeq;
        break;
      case ShmRing::ReadStatus::Closed:
        return; // source pipe retired — park (re-attach re-opens a fresh epoch)
      case ShmRing::ReadStatus::TornRead:
        std::this_thread::yield(); // transient — retry the SAME want
        break;
      case ShmRing::ReadStatus::DestTooSmall: // src_ == slot size: never expected
      case ShmRing::ReadStatus::NoNewFrame:   // not produced by readSeqInto
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
        break;
      }
    }
  }

  void compressAndOffer(size_t srcBytes, const ShmRing::ReadResult &r) {
    if (!sink_)
      return;
    const int64_t t = converterNowMs();
    if (meter_) {
      meter_->ingest("frame", t);
      meter_->begin(t);
    }
    uLongf dstLen = static_cast<uLongf>(dst_.size());
    const int rc = ::compress2(dst_.data(), &dstLen, src_.data(),
                               static_cast<uLong>(srcBytes), level_);
    if (rc != Z_OK) {
      if (meter_) {
        meter_->end(converterNowMs());
        meter_->drop();
      }
      return;
    }
    Pipe::FrameInfo info;
    // SOURCE identity forwarded verbatim (the compressed consumer must see the
    // source frame's width/height/origin, not the blob shape).
    info.width = r.width;
    info.height = r.height;
    info.channels = srcChannels_;
    info.originX = r.originX;
    info.originY = r.originY;
    info.payloadBytes = static_cast<size_t>(dstLen); // v5 opaque blob length
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(t);
    // Trusted-time: forward the source's device/system time (never restamp).
    meta.deviceTimestamp = r.meta.deviceTimestamp;
    meta.systemTimestamp = r.meta.systemTimestamp;
    sink_->offer(dst_.data(), info, meta); // v5 opaque copy of dstLen bytes
    if (meter_) {
      const int64_t done = converterNowMs();
      meter_->end(done);
      meter_->emit("shm", done);
    }
  }

  const std::string sourceShmName_;
  Pipe::FrameSink *const sink_;
  const size_t srcSlotBytes_;
  const uint32_t srcChannels_;
  const size_t srcBytesPerPixel_;
  const size_t outMaxBytes_;
  const int level_;
  Meter::ThreadMeter *const meter_; // owned by the binding; single writer here
  std::vector<uint8_t> src_;        // one source slot (runner thread only)
  std::vector<uint8_t> dst_;        // compressBound(slot) scratch (runner only)
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) --------------
struct CompressBinding {
  const std::string sourcePipeId; // the source pipe we connect + read
  const std::string sourceShmName;
  const std::string sourceFormat; // source pixelFormat (topology input edge)
  const std::string dtype;        // source container dtype (U8/U16)
  const std::string outputFormat; // sourceFormat + "/zlib" (topology fallback)
  Pipe::FrameSink *const sink = nullptr;
  const size_t srcSlotBytes = 0;
  const uint32_t srcChannels = 1;
  const size_t srcBytesPerPixel = 1;
  const size_t outMaxBytes = 0;
  const int level = Z_DEFAULT_COMPRESSION;
  bool sourceConnected = false;           // true while the runner holds a connect
  Meter::ThreadMeter meter;               // persists across gate toggles
  std::unique_ptr<CompressRunner> runner; // gated lifetime (declared LAST → dtor FIRST)

  CompressBinding(const std::string &name, std::string sourcePipeId,
                  std::string sourceShmName, std::string sourceFormat,
                  std::string dtype, std::string outputFormat,
                  Pipe::FrameSink *sink, size_t srcSlotBytes,
                  uint32_t srcChannels, size_t srcBytesPerPixel,
                  size_t outMaxBytes, int level)
      : sourcePipeId(std::move(sourcePipeId)),
        sourceShmName(std::move(sourceShmName)),
        sourceFormat(std::move(sourceFormat)), dtype(std::move(dtype)),
        outputFormat(std::move(outputFormat)), sink(sink),
        srcSlotBytes(srcSlotBytes), srcChannels(srcChannels),
        srcBytesPerPixel(srcBytesPerPixel), outMaxBytes(outMaxBytes),
        level(level), meter(name, {"frame"}, {"shm"}, converterNowMs()) {}
};

static std::mutex g_mutex;
static std::map<std::string, std::unique_ptr<CompressBinding>> g_pipes;

// ---- attach: resolve source + output sink, gate the runner -----------------
FN(attachCompressPipe) {
  auto env = info.Env();
  try {
    JS_ASSERT(info[0].IsString(), TypeError,
              "attachCompressPipe: sourcePipeId (string) required",
              env.Undefined());
    JS_ASSERT(info[1].IsString(), TypeError,
              "attachCompressPipe: pipeId (string) required", env.Undefined());
    const auto sourcePipeId = info[0].As<Napi::String>().Utf8Value();
    const auto pipeId = info[1].As<Napi::String>().Utf8Value();
    // Optional { level } (zlib 0..9 | Z_DEFAULT_COMPRESSION=-1). Default: zlib
    // default level.
    int level = Z_DEFAULT_COMPRESSION;
    if (info[2].IsObject()) {
      const auto opts = info[2].As<Napi::Object>();
      if (opts.Has("level") && opts.Get("level").IsNumber())
        level = opts.Get("level").As<Napi::Number>().Int32Value();
    }

    auto &hub = Pipe::PipeHub::instance();
    auto *sink = hub.sink(pipeId);
    JS_ASSERT(sink != nullptr, Error,
              "attachCompressPipe: unknown output pipe " + pipeId,
              env.Undefined());
    // Resolve the SOURCE pipe (must be advertised) → its segment + format.
    Pipe::Publisher *srcPub = nullptr;
    try {
      srcPub = &hub.publisher(sourcePipeId);
    } catch (...) {
      JS_THROW(Error,
               "attachCompressPipe: unknown source pipe " + sourcePipeId,
               env.Undefined());
    }
    const auto &srcSpec = srcPub->spec();
    const std::string sourceShmName = srcPub->shmName();
    const size_t srcSlotBytes =
        srcSpec.maxBytes ? static_cast<size_t>(srcSpec.maxBytes)
                         : static_cast<size_t>(srcSpec.bytesPerFrame);
    const uint32_t srcChannels = srcSpec.channels ? srcSpec.channels : 1;
    // Bytes per pixel-POSITION (channels × element size), derived from the
    // nominal advert — active bytes = width*height*this for a payloadBytes-less
    // source (raw12p → 1, BGRA8 → 4).
    const size_t pixels = static_cast<size_t>(srcSpec.width) * srcSpec.height;
    const size_t srcBytesPerPixel =
        pixels ? std::max<size_t>(1, static_cast<size_t>(srcSpec.bytesPerFrame) /
                                         pixels)
               : 1;
    // The output pipe's advertised slot capacity (offer drops if a blob exceeds
    // it — the advert should size it via compressBound(srcSlotBytes)).
    const auto &outSpec = hub.publisher(pipeId).spec();
    const size_t outMaxBytes =
        outSpec.maxBytes ? static_cast<size_t>(outSpec.maxBytes)
                         : static_cast<size_t>(outSpec.bytesPerFrame);
    const std::string outputFormat = srcSpec.pixelFormat + "/zlib";

    {
      std::scoped_lock lock(g_mutex);
      // Re-attach replaces the binding wholesale (its gated runner destructs
      // here, joining + disconnecting the old source).
      auto &existing = g_pipes[pipeId];
      if (existing && existing->sourceConnected) {
        // Release the old source connection before the binding is replaced.
        try {
          Pipe::PipeHub::instance().publisher(existing->sourcePipeId).disconnect();
        } catch (...) {
        }
        existing->sourceConnected = false;
      }
      g_pipes[pipeId] = std::make_unique<CompressBinding>(
          pipeId, sourcePipeId, sourceShmName, srcSpec.pixelFormat,
          srcSpec.dtype, outputFormat, sink, srcSlotBytes, srcChannels,
          srcBytesPerPixel, outMaxBytes, level);
    }
    // Register the gate OUTSIDE the lock: it fires immediately with the current
    // consumer state (spinning the runner + connecting the source if a consumer
    // is already connected), re-locking g_mutex.
    hub.setConsumerGate(pipeId, [pipeId](bool active) {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it == g_pipes.end() || !it->second)
        return;
      auto &b = *it->second;
      if (active && !b.runner) {
        // Connect the SOURCE (drives its producer's own gate) THEN read it.
        try {
          Pipe::PipeHub::instance().publisher(b.sourcePipeId).connect();
          b.sourceConnected = true;
        } catch (...) {
          b.sourceConnected = false;
        }
        b.runner = std::make_unique<CompressRunner>(
            b.sourceShmName, b.sink, b.srcSlotBytes, b.srcChannels,
            b.srcBytesPerPixel, b.outMaxBytes, b.level, &b.meter);
      } else if (!active && b.runner) {
        b.runner.reset(); // join the runner first (no more reads)
        if (b.sourceConnected) {
          try {
            Pipe::PipeHub::instance().publisher(b.sourcePipeId).disconnect();
          } catch (...) {
          }
          b.sourceConnected = false;
        }
      }
    });
    return Boolean::New(env, true);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- detach: unregister the gate FIRST, then drop the binding --------------
FN(detachCompressPipe) {
  auto env = info.Env();
  try {
    const auto pipeId = info[0].As<Napi::String>().Utf8Value();
    Pipe::PipeHub::instance().setConsumerGate(pipeId, nullptr);
    std::unique_ptr<CompressBinding> removed; // destructed OUTSIDE the lock (join)
    {
      std::scoped_lock lock(g_mutex);
      auto it = g_pipes.find(pipeId);
      if (it != g_pipes.end()) {
        removed = std::move(it->second);
        g_pipes.erase(it);
      }
    }
    if (removed) {
      removed->runner.reset(); // join before releasing the source connection
      if (removed->sourceConnected) {
        try {
          Pipe::PipeHub::instance().publisher(removed->sourcePipeId).disconnect();
        } catch (...) {
        }
        removed->sourceConnected = false;
      }
    }
    return Boolean::New(env, removed != nullptr);
  }
  JS_EXCEPT(env.Undefined())
}

// ---- per-pipeId compress producer meter snapshots ---------------------------
FN(compressProbeAll) {
  auto env = info.Env();
  auto out = Napi::Object::New(env);
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes)
    if (b)
      out.Set(pipeId, meterSnapshotToJs(env, b->meter.probe(converterNowMs())));
  return out;
}

// ---- Topology.report() rows: one row per compress pipe, kind "compress" -----
void appendCompressReports(Napi::Env env, Napi::Array &rows,
                           std::set<std::string> &seen) {
  std::scoped_lock lock(g_mutex);
  for (const auto &[pipeId, b] : g_pipes) {
    if (!b)
      continue;
    auto row = Topology::node(env, pipeId, "compress", "native");
    Topology::addInput(env, row, b->sourcePipeId, "frame",
                       Topology::frameType(env, b->sourceFormat, b->dtype));
    if (!Topology::decoratePipe(env, row, pipeId))
      row.Set("output", Topology::frameType(env, b->outputFormat, b->dtype));
    row.Set("stats", meterSnapshotToJs(env, b->meter.probe(converterNowMs())));
    rows.Set(rows.Length(), row);
    seen.insert(pipeId);
  }
}

} // namespace Arv
