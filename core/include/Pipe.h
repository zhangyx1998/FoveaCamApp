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
#include <condition_variable>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <napi.h>

#include "ShmWrite.h"

namespace Pipe {

/** Static typing of one pipe (mirrors `pipe-contract.ts` `PipeSpec`). */
struct PipeSpec {
  std::string id;
  std::string pixelFormat;
  std::string dtype; // echoed in the handle; JS decode uses it (native ignores)
  uint32_t width = 0;
  uint32_t height = 0;
  uint32_t channels = 1;
  uint32_t stride = 0;
  uint64_t bytesPerFrame = 0;
  uint32_t ringDepth = ShmRing::SLOT_COUNT;
};

/** Read-only view of one producer frame handed to its publisher (1:1). */
struct FrameView {
  const void *data = nullptr;
  size_t bytes = 0;
  ShmRing::FrameMeta meta;
};

class Publisher;

/** Source of frames feeding exactly one `Publisher`. Scaffold: `SyntheticProducer`.
 *  1c/1d: capture/CV producer threads — same `offer()` seam. */
class FrameProducer {
public:
  virtual ~FrameProducer() = default;
  virtual void start(Publisher &sink) = 0;
  virtual void stop() = 0;
};

/** ONE publisher thread per pipe, multi-consumer. Owns the pipe's ring
 *  (`ShmRing::Segment`) + a single-slot latest-wins handoff from its producer;
 *  the thread runs while at least one consumer is connected. */
class Publisher {
public:
  explicit Publisher(PipeSpec spec);
  ~Publisher();
  Publisher(const Publisher &) = delete;
  Publisher &operator=(const Publisher &) = delete;

  /** Producer→publisher latest-wins handoff (producer thread; non-blocking,
   *  overwrites an unconsumed frame). `frame.bytes` must equal
   *  `spec.bytesPerFrame` — otherwise the frame is dropped. */
  void offer(const FrameView &frame);

  /** Consumer refcount (broker). `connect()` starts the publisher thread on the
   *  first consumer and returns the count; `disconnect()` at zero pauses the
   *  thread but keeps the segment mapped/advertised (reconnectable). */
  uint32_t connect();
  uint32_t disconnect();
  uint32_t consumers() const { return refcount_.load(std::memory_order_acquire); }

  /** Producer-side close: stop the thread, then set `state=CLOSED` (release) so
   *  consumers observe the explicit close signal after the final frame. */
  void close();
  bool running() const { return running_.load(std::memory_order_acquire); }

  const PipeSpec &spec() const { return spec_; }
  const std::string &shmName() const { return shmName_; }

private:
  void run();          // publisher thread loop
  void startThread();
  void stopThread();

  PipeSpec spec_;
  std::string shmName_;
  std::unique_ptr<ShmRing::Segment> segment_;

  std::thread thread_;
  mutable std::mutex mutex_;
  std::condition_variable cv_;
  std::vector<uint8_t> pending_;
  ShmRing::FrameMeta pendingMeta_{};
  bool hasPending_ = false;
  bool closed_ = false;

  std::atomic<uint32_t> refcount_{0};
  std::atomic<bool> stop_{false};
  std::atomic<bool> running_{false};
};

/** Scaffold producer: emits synthetic frames at ~`fps` (byte = seed + frame#)
 *  into its publisher until stopped. Its own thread — proving per-frame work
 *  runs OFF the JS loop, the whole WS1 north star. */
class SyntheticProducer : public FrameProducer {
public:
  SyntheticProducer(PipeSpec spec, double fps, uint8_t seed);
  ~SyntheticProducer() override;
  void start(Publisher &sink) override;
  void stop() override;

private:
  PipeSpec spec_;
  double fps_;
  uint8_t seed_;
  std::thread thread_;
  std::atomic<bool> stop_{false};
};

/** Register the `core.Pipe` broker surface (advertise/connect/disconnect/close
 *  + the scaffold `attachSynthetic`) onto `exports`. */
void exportPipeNamespace(Napi::Env env, Napi::Object &exports);

} // namespace Pipe
