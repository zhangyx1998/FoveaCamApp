// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The COMPRESSION brick. A two-ended native node that consumes ANY advertised
// frame pipe and republishes each frame INTRA-FRAME compressed (every output
// frame decompresses alone — container-seekability) into an output pipe whose
// advert carries the source format with a `/codec` suffix (`BayerRG12p/zlib`).
//
// TRANSPORT: brick→brick handoffs are in-process OwnedFrame taps, NEVER SHM
// rings (rings = IPC/JS-worker boundaries ONLY). The PRIMARY compression input
// is the packed `camera/<serial>/raw12p` stream; RawPipe.cpp exposes its
// verbatim payload as an OwnedFrame tap (`openRaw12pTap`), so this brick reads
// its source via a
// latest-wins `LeakyTapChannel` (the raw12p fan-out runs on the CAPTURE thread —
// a blocking FIFO would stall capture; drops are metered via OwnedFrame.seq
// gaps). It forwards the SOURCE frame's identity (width/height/origin +
// device/system timestamps) from the OwnedFrame. The raw12p RING output stays
// unchanged as the lossless path for DIRECT (uncompressed) recording.
//
// DEMAND: the output (compress) pipe's consumer refcount gates the brick.
// On the 0→1 edge the gate OPENS a tap channel on the source + CONNECTS the
// source pipe (driving the raw12p producer's own gate, so the gated tap exists)
// + spawns the runner reading that channel; on →0 it closes the channel (waking
// the runner), joins it, and disconnects the source. All connect/disconnect +
// registry mutation stay on the NAPI thread (the gate fires there); the runner
// touches only its private tap channel + scratch buffer + the output FrameSink.
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

#include "ConverterStream.h" // converterNowMs, meterSnapshotToJs, Pipe::*, Meter,
                             // OwnedFrame, TapChannel, openRaw12pTap/closeRaw12pTap

using namespace Napi;

namespace Arv {

// ---- the runner: a private native thread polling the source OwnedFrame tap ----
// Owns its scratch buffer + the tap channel; touches nothing NAPI/registry.
// Created while the output pipe has ≥1 consumer, joined when it drops to 0.
class CompressRunner {
public:
  CompressRunner(TapChannel::Ptr channel, Pipe::FrameSink *sink,
                 size_t srcSlotBytes, uint32_t srcChannels, size_t outMaxBytes,
                 int level, Meter::ThreadMeter *meter)
      : channel_(std::move(channel)), sink_(sink), srcChannels_(srcChannels),
        outMaxBytes_(outMaxBytes), level_(level), meter_(meter) {
    // Worst-case compressed size for a full source slot (compress2 never writes
    // past this). The output pipe's advert must size maxBytes ≥ this; an
    // undersize makes offer() drop the (near-incompressible) frame.
    dst_.resize(static_cast<size_t>(
        ::compressBound(static_cast<uLong>(srcSlotBytes ? srcSlotBytes : 1))));
    thread_ = std::thread([this] { run(); });
  }
  ~CompressRunner() {
    if (channel_)
      channel_->close(); // wake a blocked poll(wait) (EOS -> run() returns)
    if (thread_.joinable())
      thread_.join();
  }
  CompressRunner(const CompressRunner &) = delete;
  CompressRunner &operator=(const CompressRunner &) = delete;

private:
  void run() {
    while (true) {
      OwnedFrame::Ptr in;
      try {
        if (!channel_->poll(in, /*wait=*/true))
          continue; // spurious wake (Leaky) — no new frame yet
      } catch (Threading::EOS &) {
        return; // channel closed (teardown / source detach) — park
      }
      if (!in)
        continue;
      // Latest-wins drops on the capture-thread fan-out since the last frame
      // (seq-gap accounting — the raw12p tap is Leaky, so a slow compressor
      // sheds stale frames, metered here exactly like a ChainedStream tap).
      if (lastSeq_ && in->seq > lastSeq_ + 1 && meter_)
        meter_->drop(static_cast<uint32_t>(in->seq - lastSeq_ - 1));
      lastSeq_ = in->seq;
      compressAndOffer(in);
    }
  }

  void compressAndOffer(const OwnedFrame::Ptr &in) {
    if (!sink_)
      return;
    const cv::Mat &m = in->mat; // U8 packed payload (deep-copied, continuous)
    const size_t srcBytes = static_cast<size_t>(m.total()) * m.elemSize();
    const int64_t t = converterNowMs();
    if (meter_) {
      meter_->ingest("frame", t);
      meter_->begin(t);
    }
    uLongf dstLen = static_cast<uLongf>(dst_.size());
    const int rc = ::compress2(dst_.data(), &dstLen, m.data,
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
    info.width = in->width();
    info.height = in->height();
    info.channels = srcChannels_;
    info.originX = in->originX;
    info.originY = in->originY;
    info.payloadBytes = static_cast<size_t>(dstLen); // v5 opaque blob length
    ShmRing::FrameMeta meta;
    meta.tCapture = static_cast<double>(t);
    // Trusted-time: forward the source's device/system time (never restamp).
    meta.deviceTimestamp = in->deviceTimestamp;
    meta.systemTimestamp = in->systemTimestamp;
    sink_->offer(dst_.data(), info, meta); // v5 opaque copy of dstLen bytes
    if (meter_) {
      const int64_t done = converterNowMs();
      meter_->end(done);
      meter_->emit("shm", done);
    }
  }

  TapChannel::Ptr channel_;         // the source's in-process OwnedFrame tap
  Pipe::FrameSink *const sink_;
  const uint32_t srcChannels_;
  const size_t outMaxBytes_;
  const int level_;
  Meter::ThreadMeter *const meter_; // owned by the binding; single writer here
  std::vector<uint8_t> dst_;        // compressBound(slot) scratch (runner only)
  uint64_t lastSeq_ = 0;            // runner-thread-only seq-gap cursor
  std::thread thread_;
};

// ---- per-pipe registry (NAPI-thread only; mutex is defensive) --------------
struct CompressBinding {
  const std::string sourcePipeId; // the raw12p source pipe we tap + connect
  const std::string sourceFormat; // source pixelFormat (topology input edge)
  const std::string dtype;        // source container dtype (U8/U16)
  const std::string outputFormat; // sourceFormat + "/zlib" (topology fallback)
  Pipe::FrameSink *const sink = nullptr;
  const size_t srcSlotBytes = 0;
  const uint32_t srcChannels = 1;
  const size_t outMaxBytes = 0;
  const int level = Z_DEFAULT_COMPRESSION;
  bool sourceConnected = false;           // true while the runner holds a connect
  TapChannel::Ptr channel;                // in-process tap (open while runner runs)
  Meter::ThreadMeter meter;               // persists across gate toggles
  std::unique_ptr<CompressRunner> runner; // gated lifetime (declared LAST → dtor FIRST)

  CompressBinding(const std::string &name, std::string sourcePipeId,
                  std::string sourceFormat, std::string dtype,
                  std::string outputFormat, Pipe::FrameSink *sink,
                  size_t srcSlotBytes, uint32_t srcChannels, size_t outMaxBytes,
                  int level)
      : sourcePipeId(std::move(sourcePipeId)),
        sourceFormat(std::move(sourceFormat)), dtype(std::move(dtype)),
        outputFormat(std::move(outputFormat)), sink(sink),
        srcSlotBytes(srcSlotBytes), srcChannels(srcChannels),
        outMaxBytes(outMaxBytes), level(level),
        meter(name, {"frame"}, {"shm"}, converterNowMs()) {}
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
    const size_t srcSlotBytes =
        srcSpec.maxBytes ? static_cast<size_t>(srcSpec.maxBytes)
                         : static_cast<size_t>(srcSpec.bytesPerFrame);
    const uint32_t srcChannels = srcSpec.channels ? srcSpec.channels : 1;
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
      if (existing && existing->channel) {
        // Unregister the old tap channel from the fan-out + close it (wakes the
        // runner's poll) before the binding is replaced (its dtor joins).
        closeRaw12pTap(existing->sourcePipeId, existing->channel);
        existing->channel = nullptr;
      }
      if (existing && existing->sourceConnected) {
        // Release the old source connection before the binding is replaced.
        try {
          Pipe::PipeHub::instance().publisher(existing->sourcePipeId).disconnect();
        } catch (...) {
        }
        existing->sourceConnected = false;
      }
      g_pipes[pipeId] = std::make_unique<CompressBinding>(
          pipeId, sourcePipeId, srcSpec.pixelFormat, srcSpec.dtype, outputFormat,
          sink, srcSlotBytes, srcChannels, outMaxBytes, level);
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
        // Open an in-process OwnedFrame tap on the source, THEN connect the
        // source pipe (drives the raw12p producer's gate so the gated tap
        // actually exists + fans out to our channel), THEN spawn the runner.
        // Leaky (latest-wins): the raw12p fan-out runs on the capture thread and
        // must never block.
        b.channel = ChannelKind::leaky().make();
        if (!openRaw12pTap(b.sourcePipeId, b.channel)) {
          // Not a raw12p source (or unknown) — no in-process tap available.
          b.channel = nullptr;
          return;
        }
        try {
          Pipe::PipeHub::instance().publisher(b.sourcePipeId).connect();
          b.sourceConnected = true;
        } catch (...) {
          b.sourceConnected = false;
        }
        b.runner = std::make_unique<CompressRunner>(
            b.channel, b.sink, b.srcSlotBytes, b.srcChannels, b.outMaxBytes,
            b.level, &b.meter);
      } else if (!active && b.runner) {
        // Close the tap FIRST (wakes the runner's blocked poll → EOS), then join
        // the runner, then disconnect the source.
        if (b.channel) {
          closeRaw12pTap(b.sourcePipeId, b.channel);
          b.channel = nullptr;
        }
        b.runner.reset(); // join the runner (no more reads)
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
      if (removed->channel) {
        // Unregister + close the tap (wakes the runner's poll) before joining.
        closeRaw12pTap(removed->sourcePipeId, removed->channel);
        removed->channel = nullptr;
      }
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
