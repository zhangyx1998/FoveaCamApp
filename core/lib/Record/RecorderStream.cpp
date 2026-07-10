// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// See RecorderStream.h for the design (threads, drop contract, trusted-time
// mapping, lifecycle). This TU implements:
//   - the producer-thread tap body (ONE tight-pack copy into a pooled slot,
//     bounded drop-oldest window per stream, never blocks the producer);
//   - the writer thread (sole McapWriter + ThreadMeter owner): lazy channel
//     registration on first frame (exactly the JS worker's `registered` set),
//     frame/telemetry/data writes, notice publication, R-1 finalize drain;
//   - the NAPI-thread lifecycle edges (add/remove stream taps, finalize
//     phase 1, abort) with all Publisher-registry access NAPI-serialized.

#include "Record/RecorderStream.h"

#include <cstdio>
#include <cstring>

#include <Aravis/ClockCalibration.h> // Arv::steadyNowNs — THE host time authority
#include <utils/debug.h>

namespace Record {

namespace {
inline int64_t nowMs() { return Arv::steadyNowNs() / 1000000; }
} // namespace

RecorderStream::RecorderStream(RecorderConfig cfg)
    : cfg_(std::move(cfg)), writer_(cfg_.chunkBytes),
      meter_(cfg_.id.empty() ? "recorder" : cfg_.id, {"frame"}, {"written"},
             nowMs()) {
  // Pre-spawn container setup on the constructing (NAPI) thread — the writer
  // thread does not exist yet, so this is the only writer_ touch off-thread.
  writer_.open(cfg_.filePath, cfg_.profile, cfg_.library);
  writer_.addMetadata(cfg_.sessionMetaName, cfg_.session);
  if (cfg_.hasCameraMatrix)
    writer_.addMetadata(cfg_.wideCameraMetaName, cfg_.cameraMatrix);
  // The telemetry channel exists on every container, registered up front
  // (schema id 1 / channel id 0 — the JS worker's exact order).
  const uint16_t telSchema = writer_.registerSchema(
      cfg_.telemetrySchemaName, cfg_.schemaEncoding,
      reinterpret_cast<const uint8_t *>(cfg_.telemetrySchemaData.data()),
      cfg_.telemetrySchemaData.size());
  telemetryChannelId_ = writer_.registerChannel(
      telSchema, cfg_.telemetryTopic, cfg_.telemetryEncoding, {});
  thread_ = std::thread([this] { writerMain(); });
}

RecorderStream::~RecorderStream() {
  // Abort-shape if never finalized. NAPI thread / env teardown — no NAPI
  // handles are touched here (plain thread join + fd close).
  abort();
  if (thread_.joinable())
    thread_.join();
}

// ---- stream churn (NAPI thread) --------------------------------------------

void RecorderStream::addStream(const std::string &name,
                               const std::string &pipeId,
                               const MetaMap &metadata, bool wantsExtras) {
  Stream *s = nullptr;
  {
    std::scoped_lock lock(m_);
    if (finalizing_)
      throw std::runtime_error("recorder addStream after finalize: " + name);
    auto it = streams_.find(name);
    if (it != streams_.end()) {
      if (it->second->live)
        throw std::runtime_error("recorder stream already live: " + name);
      // Re-add an ended name: the channel + write sequence CONTINUE (JS
      // parity); refresh the tap identity fields.
      s = it->second.get();
      s->pipeId = pipeId;
      s->metadata = metadata;
      s->wantsExtras = wantsExtras;
      s->live = true;
    } else {
      auto owned = std::make_unique<Stream>();
      owned->name = name;
      owned->pipeId = pipeId;
      owned->metadata = metadata;
      owned->wantsExtras = wantsExtras;
      owned->live = true;
      s = owned.get();
      streams_[name] = std::move(owned);
    }
  }
  // Resolve the publisher + attach the tap (NAPI thread — serialized with
  // advertise/drop). An unknown pipe throws; roll the live flag back.
  try {
    auto &pub = Pipe::PipeHub::instance().publisher(pipeId);
    pub.addRecordTap(reinterpret_cast<uintptr_t>(s),
                     [this, s](const void *data, const Pipe::FrameInfo &info,
                               const ShmRing::FrameMeta &meta) {
                       ingest(*s, data, info, meta);
                     });
  } catch (...) {
    std::scoped_lock lock(m_);
    s->live = false;
    throw std::runtime_error("recorder addStream: unknown pipe " + pipeId);
  }
}

void RecorderStream::detachTap(Stream &s) {
  // The publisher may already be gone (pipe dropped) — then its tap vector
  // died with it and there is nothing to remove.
  try {
    Pipe::PipeHub::instance()
        .publisher(s.pipeId)
        .removeRecordTap(reinterpret_cast<uintptr_t>(&s));
  } catch (...) {
  }
}

void RecorderStream::detachAllTaps() {
  std::vector<Stream *> live;
  {
    std::scoped_lock lock(m_);
    for (auto &[name, s] : streams_)
      if (s->live) {
        s->live = false;
        live.push_back(s.get());
      }
  }
  for (Stream *s : live)
    detachTap(*s);
}

void RecorderStream::removeStream(const std::string &name) {
  Stream *s = nullptr;
  {
    std::scoped_lock lock(m_);
    auto it = streams_.find(name);
    if (it == streams_.end() || !it->second->live)
      return;
    it->second->live = false;
    s = it->second.get();
  }
  // Frames already queued still write (the channel stays registered); the tap
  // detach below returns only after no in-flight ingest remains, so the caller
  // may release the pipe connection immediately after.
  detachTap(*s);
}

// ---- data channels + telemetry (NAPI thread) --------------------------------

void RecorderStream::addDataStream(const std::string &name) {
  std::scoped_lock lock(m_);
  if (finalizing_)
    throw std::runtime_error("recorder addDataStream after finalize: " + name);
  if (dataLive_[name])
    return; // one channel per name
  dataLive_[name] = true;
  if (dataSeq_.find(name) == dataSeq_.end())
    dataSeq_[name] = 0;
  // Register on the writer thread (FIFO order precedes any of its docs); the
  // channel appears in the container/summary even with zero messages.
  Item item;
  item.kind = ItemKind::DataChannel;
  item.text = name;
  queue_.push_back(std::move(item));
  cv_.notify_one();
}

void RecorderStream::removeDataStream(const std::string &name) {
  std::scoped_lock lock(m_);
  auto it = dataLive_.find(name);
  if (it != dataLive_.end())
    it->second = false; // channel stays; later postData is dropped
}

void RecorderStream::postData(const std::string &name,
                              const std::string &payloadJson) {
  std::scoped_lock lock(m_);
  if (finalizing_)
    return;
  auto it = dataLive_.find(name);
  if (it == dataLive_.end() || !it->second)
    return; // never added / removed — silently dropped (JS parity)
  Item item;
  item.kind = ItemKind::Data;
  item.text = payloadJson;
  item.seq = dataSeq_[name]++;
  item.logTimeNs = Arv::steadyNowNs(); // axis time at receipt (JS parity)
  // Reuse `stream`-less routing: carry the channel name via a second field.
  item.payload.assign(name.begin(), name.end());
  queue_.push_back(std::move(item));
  cv_.notify_one();
}

void RecorderStream::appendTelemetry(uint32_t seq, int64_t logTimeNs,
                                     const std::string &payloadJson) {
  std::scoped_lock lock(m_);
  if (finalizing_)
    return; // best-effort: a late reply degrades to a frame without extras
  Item item;
  item.kind = ItemKind::Telemetry;
  item.text = payloadJson;
  item.seq = seq;
  item.logTimeNs = logTimeNs; // the OWNING frame's container-axis time
  queue_.push_back(std::move(item));
  cv_.notify_one();
}

// ---- the producer-thread tap body -------------------------------------------

void RecorderStream::ingest(Stream &s, const void *data,
                            const Pipe::FrameInfo &info,
                            const ShmRing::FrameMeta &meta) {
  const size_t elemBytes = info.bytesPerElement ? info.bytesPerElement : 1;
  const bool opaque = info.payloadBytes > 0;
  const size_t rowBytes =
      static_cast<size_t>(info.width) * info.channels * elemBytes;
  const size_t activeBytes =
      opaque ? info.payloadBytes : rowBytes * info.height;
  // Trusted-time mapping (the JS worker's exact rule): logTime = the container
  // AXIS (host steady clock, stamped at arrival); tNs = the frame's TRUSTED
  // device time when the source stamps it (forwarded verbatim), else the axis.
  const int64_t logTimeNs = Arv::steadyNowNs();
  const int64_t tNs = meta.deviceTimestamp
                          ? static_cast<int64_t>(meta.deviceTimestamp)
                          : logTimeNs;

  std::vector<uint8_t> buf;
  {
    std::scoped_lock lock(m_);
    if (finalizing_ || !s.live)
      return; // not admitted — never counted (the tap is being detached)
    s.ingested.fetch_add(1, std::memory_order_relaxed);
    if (s.pending >= cfg_.maxQueued) {
      // Bounded window: shed the OLDEST queued frame of THIS stream
      // (drop-oldest — newest data wins). Attribution: writer mid-encode →
      // queue-caused; writer idle between items → the burst outran the drain.
      for (auto it = queue_.begin(); it != queue_.end(); ++it) {
        if (it->kind == ItemKind::Frame && it->stream == &s) {
          if (s.pool.size() < cfg_.maxQueued + 1)
            s.pool.push_back(std::move(it->payload));
          queue_.erase(it);
          --s.pending;
          s.dropped.fetch_add(1, std::memory_order_relaxed);
          if (writerBusy_.load(std::memory_order_relaxed))
            s.droppedQueue.fetch_add(1, std::memory_order_relaxed);
          else
            s.droppedRing.fetch_add(1, std::memory_order_relaxed);
          break;
        }
      }
    }
    if (!s.pool.empty()) {
      buf = std::move(s.pool.back());
      s.pool.pop_back();
    }
  }

  // THE one recorder-added copy: tight-pack the producer's (possibly strided)
  // buffer into the slot — exactly the bytes the ring records (opaque v5
  // payloads verbatim; dim-derived frames row-packed honoring stride).
  buf.resize(activeBytes);
  const auto *src = static_cast<const uint8_t *>(data);
  if (opaque) {
    std::memcpy(buf.data(), src, activeBytes);
  } else {
    const size_t stride = info.stride ? info.stride : rowBytes;
    for (uint32_t y = 0; y < info.height; ++y)
      std::memcpy(buf.data() + static_cast<size_t>(y) * rowBytes,
                  src + static_cast<size_t>(y) * stride, rowBytes);
  }

  {
    std::scoped_lock lock(m_);
    if (finalizing_ || !s.live) {
      // Lost the race against finalize/remove after admission — account it so
      // written + dropped == ingested stays exact.
      s.dropped.fetch_add(1, std::memory_order_relaxed);
      s.droppedQueue.fetch_add(1, std::memory_order_relaxed);
      if (s.pool.size() < cfg_.maxQueued + 1)
        s.pool.push_back(std::move(buf));
      return;
    }
    Item item;
    item.kind = ItemKind::Frame;
    item.stream = &s;
    item.payload = std::move(buf);
    item.logTimeNs = logTimeNs;
    item.tNs = tNs;
    queue_.push_back(std::move(item));
    ++s.pending;
  }
  cv_.notify_one();
}

// ---- the writer thread -------------------------------------------------------

void RecorderStream::registerFrameChannel(Stream &s) {
  // One raw_frame schema PER frame channel (the JS worker registered a fresh
  // schema in each registerFrameChannel — id parity preserved).
  const uint16_t schemaId = writer_.registerSchema(
      cfg_.rawFrameSchemaName, cfg_.schemaEncoding,
      reinterpret_cast<const uint8_t *>(cfg_.rawFrameSchemaData.data()),
      cfg_.rawFrameSchemaData.size());
  s.channelId = writer_.registerChannel(schemaId, s.name, cfg_.rawFrameEncoding,
                                        s.metadata);
  s.registered = true;
}

void RecorderStream::writeItem(Item &item) {
  switch (item.kind) {
  case ItemKind::Frame: {
    Stream &s = *item.stream;
    if (!s.registered)
      registerFrameChannel(s);
    const uint32_t seq = s.writeSeq++;
    const int64_t t = nowMs();
    meter_.ingest("frame", t);
    meter_.begin(t);
    writer_.addMessage(s.channelId, seq,
                       static_cast<uint64_t>(item.logTimeNs),
                       static_cast<uint64_t>(item.logTimeNs),
                       item.payload.data(), item.payload.size());
    meter_.end(nowMs());
    meter_.emit("written", nowMs());
    s.written.fetch_add(1, std::memory_order_relaxed);
    s.bytes.fetch_add(item.payload.size(), std::memory_order_relaxed);
    if (s.wantsExtras) {
      std::scoped_lock lock(noticeM_);
      if (notices_.size() >= kNoticeCap)
        notices_.pop_front(); // best-effort by contract (extras may be lost)
      notices_.push_back(FrameNotice{s.name, seq, item.logTimeNs, item.tNs});
    }
    break;
  }
  case ItemKind::Telemetry: {
    writer_.addMessage(telemetryChannelId_, item.seq,
                       static_cast<uint64_t>(item.logTimeNs),
                       static_cast<uint64_t>(item.logTimeNs),
                       reinterpret_cast<const uint8_t *>(item.text.data()),
                       item.text.size());
    break;
  }
  case ItemKind::DataChannel: {
    if (dataChannelId_.find(item.text) != dataChannelId_.end())
      break; // channel already in the container (re-add across churn)
    const uint16_t schemaId = writer_.registerSchema(
        cfg_.descriptorSchemaName, cfg_.schemaEncoding,
        reinterpret_cast<const uint8_t *>(cfg_.descriptorSchemaData.data()),
        cfg_.descriptorSchemaData.size());
    dataChannelId_[item.text] = writer_.registerChannel(
        schemaId, item.text, cfg_.descriptorEncoding, {});
    break;
  }
  case ItemKind::Data: {
    const std::string name(item.payload.begin(), item.payload.end());
    auto it = dataChannelId_.find(name);
    if (it == dataChannelId_.end())
      break; // defensive — the DataChannel item always precedes (FIFO)
    writer_.addMessage(it->second, item.seq,
                       static_cast<uint64_t>(item.logTimeNs),
                       static_cast<uint64_t>(item.logTimeNs),
                       reinterpret_cast<const uint8_t *>(item.text.data()),
                       item.text.size());
    break;
  }
  case ItemKind::Finalize:
    break; // handled by the caller
  }
}

void RecorderStream::writerMain() {
  pthread_setname_np("RecorderStream");
  for (;;) {
    Item item;
    {
      std::unique_lock lk(m_);
      writerBusy_.store(false, std::memory_order_relaxed);
      cv_.wait(lk, [&] {
        return abortRequested_.load(std::memory_order_acquire) ||
               !queue_.empty();
      });
      if (abortRequested_.load(std::memory_order_acquire))
        break;
      item = std::move(queue_.front());
      queue_.pop_front();
      if (item.kind == ItemKind::Frame)
        --item.stream->pending;
      writerBusy_.store(true, std::memory_order_relaxed);
    }
    if (item.kind == ItemKind::Finalize) {
      // R-1 drain complete (taps were detached before the marker was enqueued,
      // so everything ahead of it was the snapshot). Write the closing
      // metadata + summary/footer.
      McapWriter::Stats stats{};
      try {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%g", item.durationSec);
        writer_.addMetadata(cfg_.finalizeMetaName, {{"durationSec", buf}});
        stats = writer_.end();
      } catch (const std::exception &e) {
        ERROR("RecorderStream finalize failed: %s", e.what());
        writer_.abort();
        stats = writer_.stats();
      }
      std::scoped_lock lock(doneM_);
      finalStats_ = stats;
      done_ = true;
      doneCv_.notify_all();
      return;
    }
    try {
      writeItem(item);
    } catch (const std::exception &e) {
      // A write failure (disk full/IO error) is unrecoverable for this
      // container: leave the crash-shape file (abort) and unblock finalize.
      ERROR("RecorderStream write failed: %s", e.what());
      abortRequested_.store(true, std::memory_order_release);
      break;
    }
    if (item.kind == ItemKind::Frame) {
      // Recycle the slot buffer (bounded pool — no per-frame allocation at
      // steady state; SHM-consumer-reuse-buffer discipline).
      std::scoped_lock lock(m_);
      if (item.stream->pool.size() < cfg_.maxQueued + 1)
        item.stream->pool.push_back(std::move(item.payload));
    }
  }
  // Abort path (requested, or a write failure above): crash-shape file.
  writer_.abort();
  std::scoped_lock lock(doneM_);
  finalStats_ = writer_.stats();
  done_ = true;
  doneCv_.notify_all();
}

// ---- finalize / abort --------------------------------------------------------

void RecorderStream::beginFinalize(double durationSec) {
  {
    std::scoped_lock lock(m_);
    if (finalizing_)
      return; // idempotent
    finalizing_ = true;
  }
  detachAllTaps(); // NAPI thread — publisher-registry access stays serialized
  {
    std::scoped_lock lock(m_);
    Item item;
    item.kind = ItemKind::Finalize;
    item.durationSec = durationSec;
    queue_.push_back(std::move(item));
  }
  cv_.notify_one();
}

McapWriter::Stats RecorderStream::waitFinalize() {
  std::unique_lock lk(doneM_);
  doneCv_.wait(lk, [&] { return done_; });
  return finalStats_;
}

void RecorderStream::abort() {
  {
    std::scoped_lock lock(m_);
    finalizing_ = true;
  }
  detachAllTaps();
  abortRequested_.store(true, std::memory_order_release);
  cv_.notify_all();
}

// ---- probes -------------------------------------------------------------------

std::vector<FrameNotice> RecorderStream::takeNotices() {
  std::scoped_lock lock(noticeM_);
  std::vector<FrameNotice> out(notices_.begin(), notices_.end());
  notices_.clear();
  return out;
}

std::map<std::string, StreamCounters> RecorderStream::stats() const {
  std::map<std::string, StreamCounters> out;
  std::scoped_lock lock(m_);
  for (const auto &[name, s] : streams_) {
    StreamCounters c;
    c.ingested = s->ingested.load(std::memory_order_relaxed);
    c.dropped = s->dropped.load(std::memory_order_relaxed);
    c.droppedQueue = s->droppedQueue.load(std::memory_order_relaxed);
    c.droppedRing = s->droppedRing.load(std::memory_order_relaxed);
    c.written = s->written.load(std::memory_order_relaxed);
    c.bytes = s->bytes.load(std::memory_order_relaxed);
    out[name] = c;
  }
  return out;
}

Meter::Snapshot RecorderStream::probe() const { return meter_.probe(nowMs()); }

} // namespace Record
