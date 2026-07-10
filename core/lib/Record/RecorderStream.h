// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// native-recorder Wave 2: the RECORDER BRICK. A free-running native writer
// thread owning one hand-rolled McapWriter, fed brick→brick from record taps at
// the Publisher::offer seam (Pipe.h `RecordTap`) — the single point every
// recorded source (raw camera pipes, CompressStream /zlib outputs, derived
// bricks) already funnels through with EXACTLY the bytes the ring records
// (advert-verbatim, v5 opaque payloads included). The SHM ring hop and the JS
// recorder worker are deleted from the recording path entirely: nothing
// per-frame crosses JS, no ring read exists (SHM-pipe-architecture invariant).
//
// COPIES: exactly ONE recorder-added copy per frame — the tap tight-packs the
// producer's (possibly strided) buffer straight into a pooled queue-slot buffer
// on the producer thread (a bounded drop-oldest enqueue; never blocks capture).
// The writer thread then encodes from that slot (McapWriter's chunk assembly is
// the writer's own buffering, the same role @mcap/core's chunk builder played —
// but in C++, with zlib CRC, off every producer/JS thread).
//
// DROP CONTRACT (attribution preserved, recorder-node.ts StreamCounters shape):
// per-stream bounded pending window (`maxQueued`, default 8 — the JS path's
// DEFAULT_MAX_QUEUED_FRAMES). An arriving frame over the window sheds the
// OLDEST queued frame of that stream (drop-oldest, newest data wins):
//   - writer mid-encode (busy)   → droppedQueue (encode/write can't keep up);
//   - writer between items       → droppedRing  (burst outran the drain).
// `written + dropped == ingested`; `droppedQueue + droppedRing == dropped` —
// the exact invariants recorder-node.ts's foldStreamStats + the RecordButton
// hover attribution pin.
//
// TIMESTAMPS (trusted-time invariant): logTime = steadyNowNs() stamped ON THE
// PRODUCER THREAD at tap arrival (the container time AXIS — one clock for every
// channel; the JS worker's monotonic-clock role, same authority as core's
// steadyNowNs). tNs = the frame's TRUSTED deviceTimestamp when the source
// stamps it (forwarded verbatim through FrameMeta — never re-stamped), else the
// axis time. Telemetry docs ride with their OWNING frame's logTime (passed back
// through appendTelemetry — the JS contract unchanged).
//
// LIFECYCLE: create (open container, session/wide-camera metadata, telemetry
// channel) → addStream/removeStream + data channels churn → finalize
// (R-1 drain: detach every tap, then the writer drains the queue snapshot,
// writes the finalize metadata + summary, closes) → or abort (crash-shape file,
// no footer). The brick is NOT a ::Stream subscriber — it registers plain
// record taps, so the Stream.h teardown lifetime rules are untouched (no
// Subscriber back-pointers to eject; tests 36/38 unaffected). removeRecordTap
// returns only after no in-flight tap invocation remains, so teardown is
// synchronous and safe. The recorder holds NO hardware (janitor/quiescence
// unaffected).
//
// THREADS: NAPI thread (all public calls) / producer threads (taps: ingest) /
// the writer thread (sole McapWriter owner after spawn; sole ThreadMeter
// writer). Counters are atomics (producer-write, any-thread read).

#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <Pipe.h>
#include <ThreadMeter.h>

#include "Record/McapWriter.h"

namespace Record {

/** Everything the container needs that lives JS-side (schema.ts stays the
 *  single source of truth — C++ carries no fovea constants). */
struct RecorderConfig {
  std::string id; // graph node id (meter name — meter names ARE node ids)
  std::string filePath;
  uint64_t chunkBytes = 256 * 1024;
  uint32_t maxQueued = 8;
  std::string profile;
  std::string library;
  // fovea:session / fovea:wide-camera / fovea:finalize metadata record names.
  std::string sessionMetaName;
  std::string wideCameraMetaName;
  std::string finalizeMetaName;
  MetaMap session;              // written at open
  MetaMap cameraMatrix;         // written at open when non-empty
  bool hasCameraMatrix = false;
  // Schema payloads (name/encoding/data) — registered per channel exactly as
  // the JS worker did (one raw_frame schema PER frame channel, one descriptor
  // schema per data channel, one telemetry schema up front).
  std::string rawFrameSchemaName, rawFrameSchemaData;
  std::string descriptorSchemaName, descriptorSchemaData;
  std::string telemetrySchemaName, telemetrySchemaData;
  std::string schemaEncoding; // "jsonschema"
  std::string rawFrameEncoding;   // "x-fovea-raw"
  std::string descriptorEncoding; // "json"
  std::string telemetryEncoding;  // "json"
  std::string telemetryTopic;     // "telemetry"
};

/** Cumulative per-stream counters (recorder-node.ts StreamCounters shape). */
struct StreamCounters {
  uint64_t ingested = 0;
  uint64_t dropped = 0;
  uint64_t droppedQueue = 0;
  uint64_t droppedRing = 0;
  uint64_t written = 0;
  uint64_t bytes = 0;
};

/** A per-frame write notice (ruling-3 extras dispatch): drained by the host's
 *  low-rate poll, correlated by stream+seq. */
struct FrameNotice {
  std::string stream;
  uint32_t seq = 0;
  int64_t logTimeNs = 0;
  int64_t tNs = 0;
};

class RecorderStream {
public:
  explicit RecorderStream(RecorderConfig cfg);
  ~RecorderStream(); // abort-shape if never finalized; joins the writer thread

  RecorderStream(const RecorderStream &) = delete;
  RecorderStream &operator=(const RecorderStream &) = delete;

  /** Tap `pipeId`'s publisher and record it as channel `name`. `metadata` is
   *  the channel metadata map, copied VERBATIM (built JS-side from the advert —
   *  ruling 8: the recorder never interprets formats). `wantsExtras` gates the
   *  per-frame notices. Throws on unknown pipe / duplicate live name / after
   *  finalize. Re-adding an ENDED name continues its channel + sequence. */
  void addStream(const std::string &name, const std::string &pipeId,
                 const MetaMap &metadata, bool wantsExtras);
  /** Detach the tap; frames already queued still write; the MCAP channel stays
   *  registered; counters persist. No-op for unknown/ended names. */
  void removeStream(const std::string &name);

  /** Admit a data (descriptor) channel. Registered in the container on the
   *  writer thread (present in the summary even with zero messages, exactly as
   *  the JS path's eager registerChannel). No-op when already live. */
  void addDataStream(const std::string &name);
  /** Stop admitting writes for a data channel (the channel stays). */
  void removeDataStream(const std::string &name);
  /** Write one descriptor doc (never blocks frames; dropped when the channel
   *  is not live or the recorder is finalizing). logTime = axis-now at enqueue,
   *  sequence = per-channel counter — the JS worker's exact semantics. */
  void postData(const std::string &name, const std::string &payloadJson);

  /** Ruling-3 telemetry extras: enqueue one doc on the telemetry channel with
   *  the OWNING frame's seq + logTime (correlation contract unchanged). */
  void appendTelemetry(uint32_t seq, int64_t logTimeNs,
                       const std::string &payloadJson);

  /** Drain pending frame notices (host poll — out-of-loop, bounded buffer). */
  std::vector<FrameNotice> takeNotices();

  /** Cumulative counters per stream (includes ended streams — truthful totals
   *  across churn, the foldStreamStats contract). */
  std::map<std::string, StreamCounters> stats() const;

  /** The writer thread's profiling metric block (thread-instrumentation API). */
  Meter::Snapshot probe() const;

  /** R-1 finalize, phase 1 (NAPI THREAD — all publisher-registry access stays
   *  NAPI-serialized): refuse new admissions, detach every tap (the queue
   *  content at this instant IS the drain snapshot), enqueue the finalize
   *  marker. Idempotent. */
  void beginFinalize(double durationSec);
  /** Phase 2 (any thread — drive from an AsyncTask): block until the writer
   *  drained the snapshot + wrote the summary/footer (or an abort short-
   *  circuited it). Returns the final stats. */
  McapWriter::Stats waitFinalize();
  /** Crash-shape (NAPI THREAD): detach taps, discard the queue, close the fd
   *  with no footer. Unblocks a concurrent waitFinalize with truncated stats.
   *  Idempotent. */
  void abort();

private:
  struct Stream; // internal per-stream state

  enum class ItemKind : uint8_t { Frame, Telemetry, Data, DataChannel, Finalize };
  struct Item {
    ItemKind kind;
    Stream *stream = nullptr;       // Frame
    std::vector<uint8_t> payload;   // Frame: tight-packed bytes (pooled)
    std::string text;               // Telemetry/Data payload; Data(Channel) name
    uint32_t seq = 0;               // Telemetry: owning frame seq; Data: doc seq
    int64_t logTimeNs = 0;
    int64_t tNs = 0;
    double durationSec = 0; // Finalize
  };

  struct Stream {
    std::string name;
    std::string pipeId;
    MetaMap metadata;
    bool wantsExtras = false;
    bool live = false;      // tap attached (guards double-add / late taps)
    uint16_t channelId = 0; // registered lazily on first frame (writer thread)
    bool registered = false;
    uint32_t writeSeq = 0;              // writer thread only
    uint32_t pending = 0;               // queue-window occupancy (queue mutex)
    std::atomic<uint64_t> ingested{0};
    std::atomic<uint64_t> dropped{0};
    std::atomic<uint64_t> droppedQueue{0};
    std::atomic<uint64_t> droppedRing{0};
    std::atomic<uint64_t> written{0};
    std::atomic<uint64_t> bytes{0};
    std::vector<std::vector<uint8_t>> pool; // recycled slot buffers (queue mutex)
  };

  // Producer-thread tap body (bounded drop-oldest enqueue; never blocks).
  void ingest(Stream &s, const void *data, const Pipe::FrameInfo &info,
              const ShmRing::FrameMeta &meta);
  void detachTap(Stream &s);
  void detachAllTaps();
  void writerMain();
  void writeItem(Item &item);
  void registerFrameChannel(Stream &s);

  const RecorderConfig cfg_;
  McapWriter writer_; // writer-thread-owned after the ctor spawns the thread
  uint16_t telemetryChannelId_ = 0;

  mutable std::mutex m_;            // guards queue_, streams_ map, data sets
  std::condition_variable cv_;
  std::deque<Item> queue_;
  std::map<std::string, std::unique_ptr<Stream>> streams_;
  std::map<std::string, uint32_t> dataSeq_;   // per data channel doc sequence
  std::map<std::string, bool> dataLive_;      // admits postData
  std::map<std::string, uint16_t> dataChannelId_; // writer thread only
  bool finalizing_ = false; // set under m_: refuse new taps/admissions

  std::atomic<bool> abortRequested_{false};
  std::atomic<bool> writerBusy_{false}; // drop attribution (queue vs ring)

  // Finalize completion (writer thread → finalize()/AsyncTask waiter).
  std::mutex doneM_;
  std::condition_variable doneCv_;
  bool done_ = false;
  McapWriter::Stats finalStats_{};

  // Notice ring (writer thread pushes, host poll drains; bounded drop-oldest —
  // extras are best-effort by contract).
  static constexpr size_t kNoticeCap = 4096;
  std::mutex noticeM_;
  std::deque<FrameNotice> notices_;

  Meter::ThreadMeter meter_; // single writer = the writer thread
  std::thread thread_;
};

} // namespace Record
