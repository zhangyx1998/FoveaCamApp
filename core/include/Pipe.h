// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// WS1 producer/publisher SHM pipe architecture (C-16 scaffold). A *pipe* is one
// typed producer output. Its `Publisher` owns a `ShmRing` segment and a single
// publisher thread that seqlock-writes the latest producer frame off the JS
// loop; N consumers read it via the reader addon. A `FrameProducer` feeds one
// publisher 1:1 through a latest-wins handoff. The scaffold ships a
// `SyntheticProducer`; 1c/1d swap it for the camera/CV producer threads with no
// change to this seam. The orchestrator brokers a ONE-TIME connect handshake —
// nothing per-frame crosses JS.

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
  // C-20: the ring is sized to a tunable per-FOVEA max (NOT the camera
  // resolution — a fovea is a small hi-res crop, so N max rings stay bounded);
  // each frame carries its own active w/h ≤ max. Camera pipes: max == fixed.
  uint32_t maxWidth = 0;  // ring capacity (defaults to width if 0)
  uint32_t maxHeight = 0; // ring capacity (defaults to height if 0)
  uint64_t maxBytes = 0;  // slot size (defaults to bytesPerFrame if 0)
};

/** Geometry of one already-converted frame (in the pipe's advertised format).
 *  `stride` = bytes per row of `data` (`cv::Mat::step`); may exceed
 *  `width*channels` (the publisher copies row-by-row into the tight slot).
 *  `originX/originY` (v4, C-24/B-24): a crop's FRAME-BOUND position within its
 *  parent stream (fovea nodes) — published into the slot header alongside the
 *  active size; uncropped producers leave the defaults (0/0). */
struct FrameInfo {
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t channels = 0;
  uint32_t stride = 0;
  size_t bytes = 0;
  uint32_t originX = 0;
  uint32_t originY = 0;
  // Bytes per CHANNEL element (`cv::Mat::elemSize1()`): 1 for U8 frames
  // (default — every existing BGRA8/U8 pipe), 4 for a CV_32FC1 disparity map.
  // The publisher's tight-packed row/active-byte math multiplies by this so a
  // non-U8 mat (stereo Disparity32F) publishes without truncation. Additive:
  // defaulting to 1 keeps every U8 producer byte-for-byte unchanged.
  uint32_t bytesPerElement = 1;
  // v5 (multi-fovea-recording ruling 10): an OPAQUE variable-length payload
  // (compression bricks). When nonzero, `offer()` copies exactly `payloadBytes`
  // contiguous bytes from `data` (ignoring stride/rows) and records the length
  // in the slot header — `width/height/origin` still carry the SOURCE frame's
  // identity. 0 = a normal dim-derived frame (every existing producer — the copy
  // and slot are byte-for-byte unchanged).
  size_t payloadBytes = 0;
};

/** THE producer→publisher seam (C-19). Every producer plugs in here: B's Aravis
 *  capture hook, the option-(b) JS handoff, and the Phase-2 test driver. The
 *  producer delivers frames ALREADY CONVERTED to the pipe's advertised format
 *  (e.g. BGRA8); the publisher stays raw-memcpy+seqlock, convert-agnostic. A
 *  C++ producer obtains its sink via `PipeHub::instance().sink(pipeId)`. */
class FrameSink {
public:
  virtual ~FrameSink() = default;
  /** Latest-wins, non-blocking, thread-safe (producer thread → publisher
   *  thread). The frame's ACTIVE size must fit the ring (`info.bytes` ≤ the
   *  pipe's max slot bytes, active w/h ≤ the C-20 max footprint), else the
   *  frame is dropped (a bookkeeping drop, never a throw). */
  virtual void offer(const void *data, const FrameInfo &info,
                     const ShmRing::FrameMeta &meta) = 0;
};

/** Fired when a pipe's consumer presence crosses the 0↔1 boundary (C-21). B's
 *  `attachCameraPipe` registers one to subscribe/unsubscribe its converter to
 *  the ConverterStream — so the refcount is the SINGLE gate driving "idle when
 *  no pipe open" (the converter auto-parks once its subscriber detaches). */
using ConsumerGate = std::function<void(bool active)>;

/** Source of frames feeding exactly one publisher (via its `FrameSink`).
 *  Scaffold/test: `SyntheticProducer`. 1c/1d: capture/CV producer threads. */
class FrameProducer {
public:
  virtual ~FrameProducer() = default;
  virtual void start(FrameSink &sink) = 0;
  virtual void stop() = 0;
};

/** One publisher per pipe, multi-consumer. Owns the pipe's ring
 *  (`ShmRing::Segment`). COLLAPSED (C-19): there is NO separate publisher
 *  thread — `offer()` seqlock-writes the frame directly ON THE PRODUCER'S
 *  thread (B's per-camera capture subscriber, or the test driver), which is
 *  already off the JS loop. Single writer to the ring (1:1 producer↔pipe). */
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
   *  mapped/advertised — reconnectable). The 0→1 / →0 edges fire the consumer
   *  gate (C-21), which drives the converter subscribe/unsubscribe. */
  uint32_t connect();
  uint32_t disconnect();
  uint32_t consumers() const { return refcount_.load(std::memory_order_acquire); }

  /** Register the consumer-presence gate (C-21). Fires `gate(refcount>0)`
   *  IMMEDIATELY on registration (reconciles a consumer that connected before
   *  the gate was set), then on each 0→1 / →0 edge. `nullptr` unregisters (no
   *  fire). NAPI-thread only (single-threaded with connect/disconnect). */
  void setConsumerGate(ConsumerGate gate);

  /** Producer-side close: set `state=CLOSED` (release) so consumers observe the
   *  explicit signal after the final frame; further offers are dropped. */
  void close();

  /** Defense-in-depth teardown backstop (S-1a), fired by `PipeHub::drop` BEFORE
   *  the Publisher (segment unmap) is destroyed. Producer bindings in SEPARATE
   *  registries (RawPipe/Converter/Compress) cache this Publisher's raw
   *  `FrameSink*` and only release their gated subscriber on a consumer-gate→0
   *  edge or an explicit detach — so a `drop()` BEFORE detach would otherwise
   *  leave a live subscriber offering into freed memory on the capture/convert
   *  thread. This synchronously fires the consumer gate OFF (tearing those
   *  subscribers down), making the guarantee STRUCTURAL rather than reliant on
   *  the detach-before-unadvertise JS convention. No-op if no gate is
   *  registered. NAPI-thread only (serialized with connect/disconnect/
   *  setConsumerGate); idempotent (gate(false) with no live subscriber is a
   *  no-op). */
  void quiesceConsumers();

  const PipeSpec &spec() const { return spec_; }
  const std::string &shmName() const { return shmName_; }
  /** Segment generation = the pipe's epoch (C-20 reuse-safe identity). */
  uint32_t epoch() const { return segment_ ? segment_->generation : 0; }

  /** Out-of-loop probe of the native producer meter (orchestrator thread). */
  Meter::Snapshot probe() const;

  /** Total ACTIVE bytes ring-written since advertise (C-24 item 3) — one add
   *  per successful offer, so the topology's per-edge MB/s is exact even for
   *  variable-size fovea frames (rate × nominal would lie). Monotonic; the
   *  reader diffs snapshots. Relaxed atomic: single writer (producer thread),
   *  any-thread reads. */
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
};

/** Scaffold producer: emits synthetic frames at ~`fps` (byte = seed + frame#)
 *  into its publisher until stopped. Its own thread — proving per-frame work
 *  runs OFF the JS loop, the whole WS1 north star. */
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
  /** Advertise (idempotent for a LIVE id → returns its current epoch). A first
   *  advertise, or one after `drop`, bumps a per-id epoch → a NEW segment name
   *  (`/fv.p<hash>.g<epoch>`), so a stale consumer on the old segment sees
   *  CLOSED and never binds the reused id. Returns the epoch. */
  uint32_t advertise(const PipeSpec &spec);
  Publisher &publisher(const std::string &id);   // throws if unknown
  FrameSink *sink(const std::string &id);        // nullptr if unknown
  /** Register a pipe's consumer-presence gate (C-21) — B's `attachCameraPipe`
   *  drives its converter subscribe/unsubscribe from it. Throws if unknown. */
  void setConsumerGate(const std::string &id, ConsumerGate gate);
  void attachSynthetic(const std::string &id, double fps, uint8_t seed);
  void injectStall(const std::string &id, double ms);
  void drop(const std::string &id);
  /** Probe EVERY live pipe's meter → keyed snapshots. Dropped pipes are gone
   *  from the result (no stale workload rows under churn). */
  std::vector<std::pair<std::string, Meter::Snapshot>> probeAll();

  /** One advertised pipe's identity/liveness row (C-24 item 2 — topology
   *  discovery WITHOUT connecting). */
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
