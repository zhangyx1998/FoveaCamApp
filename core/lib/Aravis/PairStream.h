// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// pairing-nodes (ruled 2026-07-09) P-1: the per-stage L/R PAIRING brick. Two
// in-process FIFO TapChannel inputs (`OwnedFrame::Ptr` — the unified-time §5 tap
// transport; SHM rings are IPC-only, ruled 2026-07-09) joined against anchors
// pushed in at FIN rate. A pair record PINS {anchor, OwnedFrame::Ptr left,
// OwnedFrame::Ptr right} — three shared references, no pixel copies. Two join
// modes: `root` (±toleranceNs match, `matchPair` semantics ported from
// app/orchestrator/sync.ts) and `exact` (deviceTimestamp key equality, an
// anchor with that key must exist).
//
// ALWAYS-RUNNING (ruling 5), UNLIKE the demand-gated ChainedStream/StereoStream
// bricks: those park when their output loses all subscribers (the base
// `Stream::loop()` breaks on `subscribers.empty()`). A pairing brick must keep
// consuming inputs + maintaining the anchor pool even with zero output
// subscribers, dropping completed pairs immediately. We reconcile the two with
// an INTERNAL keep-alive subscriber (`begin()`), which pins the base loop active
// for the brick's whole lifetime: `start()` opens the taps once, `iterate()`
// runs the join forever, and a batch pushed with NO real subscriber is dropped
// by the keep-alive (a no-op `push`) — exactly "drop completed pairs
// immediately". The brick still dies with the session (no hardware arming → no
// quiescence interaction), released cleanly by `teardown()` (join, no leaked
// threads).
//
// THREADING: ONE brick thread (the base `Stream<PairBatch::Ptr>` thread). Both
// TapPublishers write their side-tagged `OwnedFrame`s into ONE shared bounded
// `Threading::FIFO<Tagged>` `merge_` (a custom `SideMergeChannel` per side, so
// two blocking FIFO taps collapse into ONE blocking input the brick thread can
// drain without the two-blocking-poll deadlock). `iterate()` blocks on `merge_`,
// coalesces what's immediately available, matches, and returns a batch. Single
// meter writer = the brick thread. Anchors arrive on the NAPI thread into a
// mutex-guarded bounded pool.

#include <atomic>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include <pointer.h>

#include <Threading/FIFO.h>
#include <Threading/Guard.h>
#include <Threading/exception.h>

#include "ConverterStream.h" // OwnedFrame, TapChannel, TapPublisher, ChainedStream

namespace Arv {

// Join mode: tolerance-match ONCE at the root; downstream stages join by EXACT
// key equality on the passed-through deviceTimestamp (pairing-nodes ruling 2).
enum class PairMode { Root, Exact };

// The FIN-derived anchor (pairing-nodes ruling 1/4): a REAL exposure outcome.
// `payload` is OPAQUE to the brick — the JS enrichment node packs volts / V2A
// angles / H into it; the brick pins it and echoes it back in the record.
struct PairAnchor {
  uint64_t id = 0;        // monotonic anchor id (root-assigned; carried downstream)
  int64_t tExposure = 0;  // trusted host-ns exposure time (ROOT match key)
  int32_t stream = 0;     // FIN stream id
  std::vector<double> payload; // opaque enrichment attachment (may be empty)
  // RESOLVED per-side join keys (pairing-nodes ruling 2, R-1 resolution of the
  // deferred "how downstream frames land identical keys"). A ROOT pair completes
  // on the ±tolerance window; the two matched frames' ACTUAL deviceTimestamps
  // become these keys. The root re-emits this anchor (via `pushResolvedAnchor`)
  // to DOWNSTREAM `exact`-mode bricks, which join their per-side inputs by EXACT
  // key equality (`left.deviceTimestamp == leftKey && right == rightKey`) — the
  // deviceTimestamp is passed through convert/undistort UNCHANGED (meta-passthrough
  // contract), so no frame is ever re-stamped mid-chain (trusted-time invariant).
  // Zero on a plain (unresolved) root anchor; `exact` mode uses ONLY these keys.
  int64_t leftKey = 0;
  int64_t rightKey = 0;
};

// One completed pair — PINS the two frames (no pixel copy). The pins exist so a
// FUTURE native consumer can read pixels; today they are bounded by the
// completed-pool cap and released the moment the batch is delivered/dropped.
struct PairRecord {
  PairAnchor anchor;
  OwnedFrame::Ptr left;
  OwnedFrame::Ptr right;
};

// A batch of completed pairs (MultiKcfStream batching pattern — zero per-frame
// JS work). JS consumers receive RECORDS (frame IDENTITY + opaque payload),
// never the pinned buffers.
struct PairBatch : Shared<PairBatch> {
  std::vector<PairRecord> records;
};

// Bounded pool caps (pairing-nodes ruling 3/4 — all bounded drop-oldest). See
// PairStream.cpp report notes for the rationale.
struct PairCaps {
  size_t anchors = 64;   // ~1 s of unmatched FIN backlog before drop-oldest
  size_t pending = 64;   // ~1 s @60fps per side — outlives trigger-path latency
  size_t completed = 64; // worst-case undrained backlog (2 frame pins each)
  size_t mergeCap = 256; // tap→brick FIFO bound (backpressure ceiling)
  size_t batchMax = 16;  // records per delivered batch
};

class PairStream : public ::Stream<PairBatch::Ptr> {
public:
  using Ptr = std::shared_ptr<PairStream>;
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

  static Ptr create(Source left, std::string leftId, Source right,
                    std::string rightId, std::string anchorFrom,
                    std::string name, PairMode mode, int64_t toleranceNs,
                    int64_t leftDeltaNs, int64_t rightDeltaNs,
                    const PairCaps &caps) {
    return std::make_shared<PairStream>(
        std::move(left), std::move(leftId), std::move(right), std::move(rightId),
        std::move(anchorFrom), std::move(name), mode, toleranceNs, leftDeltaNs,
        rightDeltaNs, caps);
  }

  PairStream(Source left, std::string leftId, Source right, std::string rightId,
             std::string anchorFrom, std::string name, PairMode mode,
             int64_t toleranceNs, int64_t leftDeltaNs, int64_t rightDeltaNs,
             const PairCaps &caps)
      : left_(std::move(left)), right_(std::move(right)),
        leftId_(std::move(leftId)), rightId_(std::move(rightId)),
        anchorFrom_(std::move(anchorFrom)), name_(name), mode_(mode),
        toleranceNs_(toleranceNs), leftDeltaNs_(leftDeltaNs),
        rightDeltaNs_(rightDeltaNs), caps_(caps),
        meter_(std::move(name), {"left", "right"}, {"pair"}, converterNowMs()) {}

  // NB: ::Stream<T>'s destructor is non-virtual; this brick is only held by
  // shared_ptr (its type-erased deleter destructs the concrete type).
  ~PairStream() { teardown(); }

  // Install the internal keep-alive → the base loop goes ACTIVE and stays there
  // for the brick's whole life (always-running lifecycle). Call ONCE right after
  // create() (never in the ctor — the base thread would race the vtable).
  void begin() {
    if (!keepAlive_)
      keepAlive_ = std::make_unique<KeepAlive>(this);
  }

  // NAPI thread: push a FIN-derived anchor into the bounded pool (drop-oldest).
  uint64_t pushAnchor(int64_t tExposure, int32_t stream, const double *payload,
                      size_t n) {
    std::scoped_lock lk(anchorMutex_);
    PairAnchor a;
    a.id = ++anchorSeq_;
    a.tExposure = tExposure;
    a.stream = stream;
    if (payload && n)
      a.payload.assign(payload, payload + n);
    anchorPool_.push_back(std::move(a));
    if (anchorPool_.size() > caps_.anchors) {
      anchorPool_.pop_front();
      anchorDrops_.fetch_add(1, std::memory_order_relaxed);
    }
    return anchorSeq_;
  }

  // NAPI thread: push a RESOLVED anchor into the bounded pool (drop-oldest) — the
  // root→downstream key delivery (pairing-nodes ruling 2). `id` carries the
  // ORIGIN anchor id for provenance (0 → assign a fresh one); `leftKey`/`rightKey`
  // are the root-matched per-side deviceTimestamps a downstream `exact` brick
  // joins on. `tExposure`/`payload` are echoed through unchanged. Frames are
  // NEVER re-stamped — the keys ARE the frames' own passed-through timestamps.
  uint64_t pushResolvedAnchor(uint64_t id, int64_t tExposure, int32_t stream,
                              int64_t leftKey, int64_t rightKey,
                              const double *payload, size_t n) {
    std::scoped_lock lk(anchorMutex_);
    PairAnchor a;
    const uint64_t assigned = id ? id : ++anchorSeq_;
    a.id = assigned;
    a.tExposure = tExposure;
    a.stream = stream;
    a.leftKey = leftKey;
    a.rightKey = rightKey;
    if (payload && n)
      a.payload.assign(payload, payload + n);
    anchorPool_.push_back(std::move(a));
    if (anchorPool_.size() > caps_.anchors) {
      anchorPool_.pop_front();
      anchorDrops_.fetch_add(1, std::memory_order_relaxed);
    }
    return assigned;
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  const std::string &name() const { return name_; }
  const std::string &leftId() const { return leftId_; }
  const std::string &rightId() const { return rightId_; }
  const std::string &anchorFrom() const { return anchorFrom_; }

  // Extra probe scalars (surfaced by the NAPI probe alongside the meter block).
  uint64_t anchorDrops() const {
    return anchorDrops_.load(std::memory_order_relaxed);
  }
  uint64_t leftDrops() const {
    return leftDrops_.load(std::memory_order_relaxed);
  }
  uint64_t rightDrops() const {
    return rightDrops_.load(std::memory_order_relaxed);
  }
  uint64_t completedDrops() const {
    return completedDrops_.load(std::memory_order_relaxed);
  }
  uint64_t pairsProduced() const {
    return pairsProduced_.load(std::memory_order_relaxed);
  }
  size_t anchorPoolSize() {
    std::scoped_lock lk(anchorMutex_);
    return anchorPool_.size();
  }
  PairMode mode() const { return mode_; }

protected:
  // ---- base Stream<PairBatch::Ptr> thread ----------------------------------
  void start() override {
    if (dead_.load(std::memory_order_acquire))
      return; // teardown in progress — iterate() will StopIteration at once
    auto merge = std::make_shared<Threading::FIFO<Tagged>>(caps_.mergeCap);
    { *merge_.ref() = merge; }
    auto lch = std::make_shared<SideMergeChannel>(Side::Left, merge);
    auto rch = std::make_shared<SideMergeChannel>(Side::Right, merge);
    leftPub_ = std::make_unique<TapPublisher>(left_.get(), lch);
    rightPub_ = std::make_unique<TapPublisher>(right_.get(), rch);
    if (!leftPub_->state.snapshot().isActive() ||
        !rightPub_->state.snapshot().isActive())
      throw std::runtime_error("pair chain source stream already terminated");
  }

  void stop() override {
    // Close the merge FIFO FIRST: it may have a source blocked in a full-queue
    // push (backpressure) while holding the source's dispatch mutex. Closing
    // wakes it (EOS -> Unsubscribe) so the source releases that mutex before we
    // unsubscribe (which also needs it) — the ChainedStream deadlock note.
    closeMerge();
    leftPub_.reset();
    rightPub_.reset();
    { *merge_.ref() = nullptr; }
    // Per-activation state (brick thread only here): drop pins.
    leftPending_.clear();
    rightPending_.clear();
    completed_.clear();
    lastLeftSeq_ = lastRightSeq_ = 0;
  }

  PairBatch::Ptr iterate() override {
    if (dead_.load(std::memory_order_acquire))
      throw StopIteration();
    std::shared_ptr<Threading::FIFO<Tagged>> merge;
    { merge = *merge_.ref(); }
    if (!merge)
      throw StopIteration();
    try {
      processTagged(merge->read()); // BLOCKS for the first item
      // Coalesce whatever is ALREADY queued (MultiKcf-style batching). NB:
      // FIFO::read(timeout) does NOT time out on an empty queue (its wait loop
      // has no deadline check), so we drain by queued_size() instead — safe
      // because the brick thread is the SOLE consumer (size>0 ⇒ read won't
      // block).
      while (merge->queued_size() > 0)
        processTagged(merge->read());
    } catch (Threading::EOS &) {
      throw StopIteration(); // merge closed (teardown / source death)
    }
    if (completed_.empty())
      return nullptr; // no pair formed — base yields, then blocks again
    return makeBatch();
  }

private:
  enum class Side { Left, Right };
  struct Tagged {
    Side side;
    OwnedFrame::Ptr frame;
  };

  // A per-side TapChannel that funnels side-tagged frames into ONE shared merge
  // FIFO — so the two blocking FIFO taps present ONE blocking input. `poll()` is
  // unused (the brick reads `merge_` directly). Closing either side closes the
  // shared FIFO: either source terminating ends the brick (StereoStream
  // contract).
  class SideMergeChannel : public TapChannel {
  public:
    SideMergeChannel(Side side, std::shared_ptr<Threading::FIFO<Tagged>> merge)
        : side_(side), merge_(std::move(merge)) {}
    void write(OwnedFrame::Ptr &frame) override {
      Tagged t{side_, frame};
      merge_->write(t); // BLOCKS while full (backpressure); EOS on close
    }
    bool poll(OwnedFrame::Ptr &, bool) override {
      throw std::runtime_error("SideMergeChannel::poll unused");
    }
    void close() override { merge_->close(); }

  private:
    const Side side_;
    std::shared_ptr<Threading::FIFO<Tagged>> merge_;
  };

  // Internal keep-alive subscriber: pins the base loop active for the brick's
  // whole life (always-running), and DISCARDS batches so a zero-real-subscriber
  // brick drops completed pairs immediately (ruling 5).
  struct KeepAlive : public Subscriber<PairBatch::Ptr> {
    explicit KeepAlive(PairStream *s) : Subscriber<PairBatch::Ptr>(s) {}
    void push(const PairBatch::Ptr &) override {} // drop
  };

  void processTagged(const Tagged &item) {
    const int64_t t = converterNowMs();
    meter_.begin(t);
    ingest(item.side, item.frame, t);
    tryMatch();
    meter_.end(converterNowMs());
  }

  void ingest(Side s, const OwnedFrame::Ptr &f, int64_t t) {
    if (!f)
      return;
    auto &pool = (s == Side::Left) ? leftPending_ : rightPending_;
    auto &lastSeq = (s == Side::Left) ? lastLeftSeq_ : lastRightSeq_;
    auto &drops = (s == Side::Left) ? leftDrops_ : rightDrops_;
    if (lastSeq && f->seq > lastSeq + 1)
      meter_.drop(f->seq - lastSeq - 1); // latest-wins gap upstream of the tap
    lastSeq = f->seq;
    meter_.ingest(s == Side::Left ? "left" : "right", t);
    pool.push_back(f);
    if (pool.size() > caps_.pending) {
      pool.pop_front(); // aged out unmatched — drop-oldest
      drops.fetch_add(1, std::memory_order_relaxed);
      meter_.drop();
    }
  }

  // `exactKey` is the per-side join key (leftKey for the left pool, rightKey for
  // the right) — used ONLY in Exact mode; Root mode ignores it and tolerance-
  // matches the frame's deviceTimestamp (+ side delta) against tExposure.
  bool matchesFrame(const OwnedFrame::Ptr &f, const PairAnchor &a, int64_t delta,
                    int64_t exactKey) const {
    const int64_t ts = static_cast<int64_t>(f->deviceTimestamp);
    if (mode_ == PairMode::Exact)
      return ts == exactKey; // per-side key equality (root-resolved downstream)
    const int64_t predicted = ts + delta;             // matchesExposure (sync.ts)
    const int64_t diff = predicted > a.tExposure ? predicted - a.tExposure
                                                 : a.tExposure - predicted;
    return diff <= toleranceNs_;
  }

  // Sweep anchors oldest-first; complete + retire any with BOTH sides present.
  void tryMatch() {
    std::scoped_lock lk(anchorMutex_);
    for (auto ai = anchorPool_.begin(); ai != anchorPool_.end();) {
      const PairAnchor &a = *ai;
      auto li = findSide(leftPending_, a, leftDeltaNs_, a.leftKey);
      auto ri = findSide(rightPending_, a, rightDeltaNs_, a.rightKey);
      if (li != leftPending_.end() && ri != rightPending_.end()) {
        PairRecord rec{a, *li, *ri};
        leftPending_.erase(li);
        rightPending_.erase(ri);
        ai = anchorPool_.erase(ai);
        pushCompleted(std::move(rec));
      } else {
        ++ai;
      }
    }
  }

  std::deque<OwnedFrame::Ptr>::iterator
  findSide(std::deque<OwnedFrame::Ptr> &pool, const PairAnchor &a, int64_t delta,
           int64_t exactKey) {
    for (auto it = pool.begin(); it != pool.end(); ++it)
      if (matchesFrame(*it, a, delta, exactKey))
        return it;
    return pool.end();
  }

  void pushCompleted(PairRecord &&rec) {
    pairsProduced_.fetch_add(1, std::memory_order_relaxed);
    meter_.emit("pair", converterNowMs());
    completed_.push_back(std::move(rec));
    if (completed_.size() > caps_.completed) {
      completed_.pop_front(); // undrained (zero-subscriber) — drop-oldest
      completedDrops_.fetch_add(1, std::memory_order_relaxed);
      meter_.drop();
    }
  }

  PairBatch::Ptr makeBatch() {
    auto batch = PairBatch::create();
    const size_t n = std::min(completed_.size(), caps_.batchMax);
    batch->records.reserve(n);
    for (size_t i = 0; i < n; i++) {
      batch->records.push_back(std::move(completed_.front()));
      completed_.pop_front();
    }
    return batch;
  }

  void closeMerge() {
    auto ref = merge_.ref();
    if (*ref)
      (*ref)->close();
  }

  // Idempotent lifecycle teardown: wake the brick thread out of its blocking
  // merge read, drop the keep-alive so subscribers can empty, then join.
  void teardown() {
    if (torn_.exchange(true))
      return;
    dead_.store(true, std::memory_order_release); // start()/iterate() short-out
    closeMerge();       // wake a brick thread blocked in merge_->read() (EOS)
    keepAlive_.reset(); // unsubscribe → base loop may park
    shutdown();         // base: flag_terminate + notify + join (no leaked thread)
  }

  const Source left_, right_; // shared: keep the upstream bricks alive
  const std::string leftId_, rightId_, anchorFrom_, name_;
  const PairMode mode_;
  const int64_t toleranceNs_, leftDeltaNs_, rightDeltaNs_;
  const PairCaps caps_;

  Threading::Guard<std::shared_ptr<Threading::FIFO<Tagged>>> merge_{nullptr};
  std::unique_ptr<TapPublisher> leftPub_, rightPub_; // exist only while active
  std::unique_ptr<KeepAlive> keepAlive_;             // always-running pin

  // Brick-thread-only pools.
  std::deque<OwnedFrame::Ptr> leftPending_, rightPending_;
  std::deque<PairRecord> completed_;
  uint64_t lastLeftSeq_ = 0, lastRightSeq_ = 0;

  // Anchor pool: NAPI writer (pushAnchor) + brick reader (tryMatch), guarded.
  std::mutex anchorMutex_;
  std::deque<PairAnchor> anchorPool_;
  uint64_t anchorSeq_ = 0;

  Meter::ThreadMeter meter_; // single writer = brick thread

  std::atomic<uint64_t> anchorDrops_{0}, leftDrops_{0}, rightDrops_{0},
      completedDrops_{0}, pairsProduced_{0};
  std::atomic<bool> dead_{false}, torn_{false};
};

// Cross-brick lookup (topology + NAPI registry): the live pairing brick bound
// to `stage`, or nullptr. Defined in PairStream.cpp (owns the registry).
PairStream::Ptr findPair(const std::string &stage);

// A test-only synthetic ConvertedFrame producer the join test pushes frames
// into with EXPLICIT deviceTimestamps (the fake camera can't control those).
// Resolved as a PairStream source by `createPairStream`. Defined in
// PairStream.cpp.
PairStream::Source findPairTestSource(const std::string &id);

} // namespace Arv
