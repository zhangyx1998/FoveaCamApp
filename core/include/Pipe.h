// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// Producer/publisher SHM pipe architecture. A *pipe* is one typed producer
// output: a `Publisher` owns a `ShmRing` segment that N consumers read via the
// reader addon; producers seqlock-write off the JS loop. The orchestrator
// brokers a ONE-TIME connect handshake. spec: docs/spec/core-pipe.md

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <napi.h>

#include "ShmWrite.h"
#include "ThreadMeter.h"

namespace Pipe {

/** Static typing of one pipe (mirrors `pipe-contract.ts` `PipeSpec`). */
struct PipeSpec {
  std::string id;
  std::string pixelFormat;
  std::string dtype; // echoed in the handle; JS decode uses it (native ignores)
  uint32_t width = 0;  // nominal/initial active size
  uint32_t height = 0;
  uint32_t channels = 1;
  uint32_t stride = 0;
  uint64_t bytesPerFrame = 0;
  uint32_t ringDepth = ShmRing::SLOT_COUNT;
  // Ring is sized to a per-FOVEA max, not the camera resolution; each frame
  // carries its own active w/h ≤ max. spec: docs/spec/core-pipe.md#sizing
  uint32_t maxWidth = 0;  // ring capacity (defaults to width if 0)
  uint32_t maxHeight = 0; // ring capacity (defaults to height if 0)
  uint64_t maxBytes = 0;  // slot size (defaults to bytesPerFrame if 0)
};

/** Geometry of one already-converted frame (in the pipe's advertised format).
 *  Field semantics (stride, origin, bytesPerElement, payloadBytes):
 *  spec: docs/spec/core-pipe.md#sizing */
struct FrameInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t channels = 0;
  uint32_t stride = 0; // bytes per row of `data` (cv::Mat::step); may exceed w*ch
  size_t bytes = 0;
  uint32_t originX = 0; // crop position within the parent stream (fovea nodes)
  uint32_t originY = 0;
  uint32_t bytesPerElement = 1; // cv::Mat::elemSize1(); 4 for CV_32FC1 disparity
  size_t payloadBytes = 0; // >0 = opaque variable-length payload (compression)
};

/** THE producer→publisher seam. Every producer plugs in here: B's Aravis
 *  capture hook, the JS handoff, and the test driver. The
 *  producer delivers frames ALREADY CONVERTED to the pipe's advertised format
 *  (e.g. BGRA8); the publisher stays raw-memcpy+seqlock, convert-agnostic. A
 *  C++ producer obtains its sink via `PipeHub::instance().sink(pipeId)`. */
class FrameSink {
public:
  virtual ~FrameSink() = default;
  /** Latest-wins, non-blocking, thread-safe (producer thread → publisher
   *  thread). The frame's ACTIVE size must fit the ring (`info.bytes` ≤ the
   *  pipe's max slot bytes, active w/h ≤ the max footprint), else the
   *  frame is dropped (a bookkeeping drop, never a throw). */
  virtual void offer(const void *data, const FrameInfo &info,
                     const ShmRing::FrameMeta &meta) = 0;
};

/** Fired when a pipe's consumer presence crosses the 0↔1 boundary. B's
 *  `attachCameraPipe` registers one to subscribe/unsubscribe its converter to
 *  the ConverterStream — so the refcount is the SINGLE gate driving "idle when
 *  no pipe open" (the converter auto-parks once its subscriber detaches). */
using ConsumerGate = std::function<void(bool active)>;

/** native-recorder: an in-process tap at the publisher seam, fired on the
 *  producer thread for every accepted frame with the producer's ORIGINAL
 *  buffer. The callee must copy synchronously and NEVER block (drop-oldest
 *  enqueue only). spec: docs/spec/core-pipe.md#record-tap */
using RecordTap =
    std::function<void(const void *data, const FrameInfo &info,
                       const ShmRing::FrameMeta &meta)>;

/** Source of frames feeding exactly one publisher (via its `FrameSink`).
 *  Scaffold/test: `SyntheticProducer`. 1c/1d: capture/CV producer threads. */
class FrameProducer {
public:
  virtual ~FrameProducer() = default;
  virtual void start(FrameSink &sink) = 0;
  virtual void stop() = 0;
};

/** One publisher per pipe, multi-consumer. Owns the pipe's `ShmRing::Segment`.
 *  No separate publisher thread — `offer()` seqlock-writes on the producer's
 *  thread (single writer, 1:1). spec: docs/spec/core-pipe.md#seam */
class Publisher : public FrameSink {
public:
  /** `epoch` = the segment generation (bumped on re-advertise of an id). */
  Publisher(PipeSpec spec, uint32_t epoch);
  ~Publisher() override = default;
  Publisher(const Publisher &) = delete;
  Publisher &operator=(const Publisher &) = delete;

  /** FrameSink: seqlock-write the frame into the next ring slot (row-by-row,
   *  honoring `info.stride`), on the producer's thread. Records the native
   *  meter (the producer thread is the meter's sole writer). Writes only while
   *  ≥1 consumer is connected and the pipe is open; a size mismatch is dropped. */
  void offer(const void *data, const FrameInfo &info,
             const ShmRing::FrameMeta &meta) override;

  /** Consumer refcount (broker). At zero the ring write pauses (segment stays
   *  reconnectable). The 0↔1 edges fire the consumer gate.
   *  spec: docs/spec/core-pipe.md#refcount-gate */
  uint32_t connect();
  uint32_t disconnect();
  uint32_t consumers() const { return refcount_.load(std::memory_order_acquire); }

  /** Register the consumer-presence gate. Fires `gate(refcount>0)` IMMEDIATELY
   *  on registration, then on each edge. `nullptr` unregisters. NAPI-thread
   *  only. spec: docs/spec/core-pipe.md#refcount-gate */
  void setConsumerGate(ConsumerGate gate);

  /** Producer-side close: set `state=CLOSED` (release) so consumers observe the
   *  explicit signal after the final frame; further offers are dropped. */
  void close();

  /** Defense-in-depth teardown backstop (S-1a): fired by `PipeHub::drop` BEFORE
   *  segment unmap, synchronously firing the consumer gate OFF so cached-sink
   *  producers (RawPipe/Converter/Compress) tear down instead of offering into
   *  freed memory. NAPI-thread only; idempotent.
   *  spec: docs/spec/core-pipe.md#quiesce */
  void quiesceConsumers();

  /** native-recorder: add/remove a record tap keyed by `token`. `removeRecordTap`
   *  returns only after no in-flight tap can still run (owner may then free
   *  capture state). spec: docs/spec/core-pipe.md#record-tap */
  void addRecordTap(uintptr_t token, RecordTap tap);
  void removeRecordTap(uintptr_t token);

  const PipeSpec &spec() const { return spec_; }
  const std::string &shmName() const { return shmName_; }
  /** Segment generation = the pipe's epoch (reuse-safe identity). */
  uint32_t epoch() const { return segment_ ? segment_->generation : 0; }

  /** Out-of-loop probe of the native producer meter (orchestrator thread). */
  Meter::Snapshot probe() const;

  /** Total ACTIVE bytes ring-written since advertise — one add per offer, so
   *  per-edge MB/s is exact even for variable-size fovea frames. Monotonic,
   *  relaxed atomic. spec: docs/spec/core-pipe.md#epoch */
  uint64_t bytesTotal() const { return bytesTotal_.load(std::memory_order_relaxed); }

  bool isClosed() const { return closed_.load(std::memory_order_acquire); }

private:
  PipeSpec spec_;
  std::string shmName_;
  std::unique_ptr<ShmRing::Segment> segment_;
  Meter::ThreadMeter meter_; // written only by the producer thread (offer)

  std::atomic<uint32_t> refcount_{0};
  std::atomic<bool> closed_{false};
  std::atomic<uint64_t> bytesTotal_{0}; // producer-thread writer, relaxed reads
  ConsumerGate gate_; // NAPI-thread only (connect/disconnect/setConsumerGate)

  // native-recorder taps: fired under `tapMutex_` in offer() (producer thread);
  // add/remove serialize on the same mutex, so removeRecordTap() returning
  // proves no tap invocation is still in flight. `hasTaps_` gates the lock
  // acquisition so untapped pipes pay one relaxed atomic load per frame.
  std::mutex tapMutex_;
  std::vector<std::pair<uintptr_t, RecordTap>> taps_;
  std::atomic<bool> hasTaps_{false};
};

/** Scaffold producer: emits synthetic frames at ~`fps` (byte = seed + frame#)
 *  into its publisher until stopped. Its own thread — proving per-frame work
 *  runs OFF the JS loop. */
class SyntheticProducer : public FrameProducer {
public:
  SyntheticProducer(PipeSpec spec, double fps, uint8_t seed);
  ~SyntheticProducer() override;
  void start(FrameSink &sink) override;
  void stop() override;
  /** Test hook: pause offering for ~`ms` on the producer thread, simulating a
   *  producer/capture stall — the probed `maxIntervalMs` then spikes. */
  void injectStall(double ms) { stallMs_.store(ms, std::memory_order_release); }

private:
  PipeSpec spec_;
  double fps_;
  uint8_t seed_;
  std::thread thread_;
  std::atomic<bool> stop_{false};
  std::atomic<double> stallMs_{0};
};

struct PipeEntry {
  PipeSpec spec;
  std::unique_ptr<Publisher> publisher;
  std::unique_ptr<SyntheticProducer> producer;
};

/** Process-wide pipe registry/broker. A C++ producer (B's Aravis capture
 *  subscriber) obtains its `FrameSink` via `PipeHub::instance().sink(id)`; the
 *  orchestrator drives advertise/connect/probe/drop through the NAPI surface. */
class PipeHub {
public:
  static PipeHub &instance();
  /** Advertise (idempotent for a LIVE id). A first advertise, or one after
   *  `drop`, bumps a per-id epoch → a NEW segment name, so stale consumers on
   *  the old segment see CLOSED. spec: docs/spec/core-pipe.md#epoch */
  uint32_t advertise(const PipeSpec &spec);
  Publisher &publisher(const std::string &id);   // throws if unknown
  FrameSink *sink(const std::string &id);        // nullptr if unknown
  /** Register a pipe's consumer-presence gate — B's `attachCameraPipe`
   *  drives its converter subscribe/unsubscribe from it. Throws if unknown. */
  void setConsumerGate(const std::string &id, ConsumerGate gate);
  void attachSynthetic(const std::string &id, double fps, uint8_t seed);
  void injectStall(const std::string &id, double ms);
  void drop(const std::string &id);
  /** Probe EVERY live pipe's meter → keyed snapshots. Dropped pipes are gone
   *  from the result (no stale workload rows under churn). */
  std::vector<std::pair<std::string, Meter::Snapshot>> probeAll();

  /** One advertised pipe's identity/liveness row (topology discovery WITHOUT
   *  connecting). */
  struct ListEntry {
    std::string id;
    PipeSpec spec;
    uint32_t epoch = 0;
    uint32_t consumers = 0;
    bool closed = false;
    uint64_t bytesTotal = 0; // see Publisher::bytesTotal
  };
  /** Enumerate every advertised pipe (dropped pipes absent). */
  std::vector<ListEntry> list();

private:
  std::mutex m_;
  std::map<std::string, PipeEntry> pipes_;
  std::map<std::string, uint32_t> epochs_; // per-id, PERSISTS across drop
};

/** Register the `core.Pipe` broker surface (advertise/connect/disconnect/close/
 *  probe + the test `attachSynthetic`/`injectStall`) onto `exports`. */
void exportPipeNamespace(Napi::Env env, Napi::Object &exports);

} // namespace Pipe
