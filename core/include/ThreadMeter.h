// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// Native free-thread instrumentation meter (C-19, WS1 real-1c). The C++ mirror
// of the JS `Workload` meter (metering.ts): a free-running producer/publisher
// thread records ingest/emit/busy/drop into its OWN meter, and the orchestrator
// PROBES it out-of-loop (never per-frame) into `perfSnapshot.workloads` using
// the SAME schema C-18 defined (`WorkloadStreamStat{count,ratePerSec,
// maxIntervalMs}`, `INTERVAL_WINDOW{bins:10,binMs:1000}`), so the profiler
// renders a native producer stream identically to a JS one.
//
// SINGLE WRITER (the owning thread) + SEQLOCK reader: the writer bumps an
// even/odd `version` around each mutation; the probe reads a consistent COPY of
// the POD block (retry on a torn read — the same discipline as the SHM ring)
// and computes the metrics on the copy at `now` (rotate-on-copy → correct
// aging + a live in-progress stall). No cross-process SHM: the block is
// orchestrator-local. Generalized so 1d's KCF thread reuses it.
//
// System-library-only (std + atomics); no N-API/OpenCV/Aravis — the N-API glue
// that turns a `Snapshot` into a JS object lives in the caller (Pipe.cpp).

#include <atomic>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace Meter {

constexpr uint32_t BIN_COUNT = 10;   // 10 × 1 s bins == INTERVAL_WINDOW
constexpr int64_t BIN_MS = 1000;
constexpr uint32_t MAX_STREAMS = 8;  // inputs or outputs per meter
constexpr uint32_t MAX_RETRIES = 8;  // seqlock read retries before giving up

/** One stream's probed view (mirror of the JS `WorkloadStreamStat`). */
struct StreamStat {
  uint64_t count = 0;
  double ratePerSec = 0;
  double maxIntervalMs = 0;
};

/** Probed snapshot (mirror of the JS `WorkloadSnapshot`). Plain data. */
struct Snapshot {
  std::string name;
  int64_t startedAtMs = 0;
  int64_t snapshotAtMs = 0;
  int64_t uptimeMs = 1;
  double utilization = 0;
  double busyMs = 0;
  std::vector<std::pair<std::string, StreamStat>> inputs;
  std::vector<std::pair<std::string, StreamStat>> outputs;
  uint64_t dropTotal = 0;
  // FIFO-input queue metering (controller-node-and-fifo-edges §1/§2). Present
  // ONLY when the meter recorded ≥1 depth sample (`hasQueue`) — a FIFO-fed
  // brick (undistort). Leaky-fed bricks leave it absent so `meterSnapshotToJs`
  // omits the `queue` key. `queueHighWater` is the windowed (10s) max of the
  // sampled depths; `queueDepth` is the last sample; `queueCapacity` the bound.
  bool hasQueue = false;
  uint32_t queueDepth = 0;
  uint32_t queueHighWater = 0;
  uint32_t queueCapacity = 0;
};

class ThreadMeter {
public:
  /** `now` = wall-clock ms (caller supplies a monotonic-ish clock; the pipe
   *  passes host ms). Streams are pre-declared for a stable snapshot shape. */
  ThreadMeter(std::string name, std::vector<std::string> inputs,
              std::vector<std::string> outputs, int64_t nowMs);

  // ---- writer side (the owning thread ONLY) ----
  void ingest(const std::string &stream, int64_t nowMs);
  void emit(const std::string &stream, int64_t nowMs);
  void begin(int64_t nowMs);
  void end(int64_t nowMs);
  /** Attribute `ms` of busy time directly (e.g. a producer's per-frame convert
   *  time from `FrameMeta.convertMs`) without an open span. */
  void addBusy(double ms);
  void drop(uint64_t n = 1);
  /** Record one input-queue depth sample (FIFO-fed bricks only). `depth` is
   *  the peak occupancy observed since the previous sample (windowed-max fed →
   *  `queueHighWater`) and also stored as the last-sampled `queueDepth`;
   *  `capacity` is the FIFO bound. The first call flips the snapshot's
   *  `hasQueue` on. Same 10s/1s-bin aging as `maxIntervalMs`. */
  void queueDepth(uint32_t depth, uint32_t capacity, int64_t nowMs);

  // ---- probe side (any thread) ----
  /** Seqlock-read a consistent copy and compute the metrics at `nowMs`. */
  Snapshot probe(int64_t nowMs) const;

private:
  // Per-stream interval ring (C-18 bin-ring). POD — copied under the seqlock.
  struct Ring {
    double bins[BIN_COUNT] = {};
    int64_t binStart = 0;
    uint32_t cursor = 0;
    int64_t lastEventTs = -1; // -1 = no event yet
    uint64_t count = 0;
  };
  // Trivially-copyable block the probe snapshots under the seqlock.
  struct Block {
    Ring inputs[MAX_STREAMS] = {};
    Ring outputs[MAX_STREAMS] = {};
    double busyMs = 0;
    int64_t openSpanAt = -1; // -1 = no open busy span
    uint64_t dropTotal = 0;
    // Queue-depth metering (FIFO inputs). `queueRing` bins the depth samples
    // as per-bin MAX (windowed high-water); `queueLastDepth`/`queueCapacity`
    // are scalars; `hasQueue` gates emission.
    Ring queueRing = {};
    uint32_t queueLastDepth = 0;
    uint32_t queueCapacity = 0;
    bool hasQueue = false;
  };

  int32_t indexOf(const std::vector<std::string> &names, const std::string &s) const;

  // Bin-ring helpers (C-18 port). Static — they operate on a POD Ring; the
  // probe calls them on its seqlock COPY, the writer on the live block.
  static void rotate(Ring &r, int64_t now);
  static void recordEvent(Ring &r, int64_t now);
  static double ringMax(Ring r, int64_t now); // by value: rotates the copy
  static StreamStat streamStat(const Ring &r, int64_t now, int64_t uptimeMs);
  // Record a raw VALUE (not an interval) as the current bin's max, and the
  // windowed max over the bins (queue-depth metering). recordValue mutates the
  // live block; ringValueMax rotates a by-value copy on the probe side.
  static void recordValue(Ring &r, int64_t now, double value);
  static double ringValueMax(Ring r, int64_t now);

  std::string name_;
  std::vector<std::string> inputNames_;
  std::vector<std::string> outputNames_;
  int64_t createdAtMs_;
  Block block_;
  std::atomic<uint64_t> version_{0}; // even = stable, odd = writer in progress
};

} // namespace Meter
