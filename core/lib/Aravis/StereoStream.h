// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// The FIRST two-input chained brick: SGBM/BM disparity over an L/R frame pair.
// Two input modes chosen at CONSTRUCTION (latest-wins OwnedFrame taps, or a
// PairStream record tap over exposure pairs); output is CV_32F disparity in
// full-res LEFT-frame pixel units, timestamps forwarded from the LEFT frame
// (never re-stamped). spec: docs/spec/core-frame-bricks.md#stereo

#include <atomic>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <mutex>

#include <opencv2/opencv.hpp>

// WLS guided disparity refinement (stereo-throughput.md candidate C) — an
// OPTIONAL opencv_contrib module. Compile-guarded on the CMake-side link
// decision (HAVE_OPENCV_XIMGPROC_WLS, set iff find_package resolved the
// OPTIONAL ximgproc component): a build without contrib still compiles, and
// `wls: true` degrades to the unfiltered map on it.
#ifdef HAVE_OPENCV_XIMGPROC_WLS
#include <opencv2/ximgproc/disparity_filter.hpp>
#endif

#include <Threading/Guard.h>
#include <Threading/Ring.h> // RecordChannel (drop-oldest paired-record tap)

#include "ConverterStream.h" // TapPublisher, TapChannel, ChannelKind, ...
#include "PairStream.h"      // PairBatch, PairRecord, Stream<PairBatch::Ptr>

namespace Arv {

/** Matcher strategy (stereo-throughput.md ruling 1: "the matcher is not
 *  sacred") — selectable live like every other reactive param. */
enum class StereoAlgorithm { SGBM = 0, BM = 1 };

// The reactive matcher spec — validated on the NAPI thread (see
// StereoStream.cpp), applied on the brick thread (rebuilds the matcher).
// numDisparities rounded up to a multiple of 16 (min 16); blockSize forced odd
// (min 1); minDisparity any (signed — sgbm-signed-range.md).
//
// Throughput params (stereo-throughput.md): `matchScale` (1|2|4) matches at
// 1/scale resolution with the window scaled alongside (numDisparities/scale,
// minDisparity/scale) and multiplies the disparity VALUES back to full-res
// left-frame pixel units; the OUTPUT MAP is emitted at match scale. `mode`
// picks the SGBM variant (MODE_SGBM / MODE_SGBM_3WAY / MODE_HH); `algorithm`
// swaps SGBM for the faster classic StereoBM. `wls` enables the ximgproc
// WLS guided refine (needs a second right-view match — roughly doubles match
// cost; no-op on builds without opencv_contrib).
//
// DEFAULTS = the 43-stereo-throughput.ts bench winner on camera-res synthetic
// frames with the ruled ±256 window (see the bench table in the proposal's
// AS-SHIPPED note): scaled SGBM_3WAY at 1/4 — ~60 fps at quality parity.
struct StereoParams {
  int numDisparities = 128;
  int blockSize = 5;
  int minDisparity = 0;
  StereoAlgorithm algorithm = StereoAlgorithm::SGBM;
  int mode = cv::StereoSGBM::MODE_SGBM_3WAY;
  int matchScale = 4; // 1 | 2 | 4
  bool wls = false;
  double wlsLambda = 8000.0;
  double wlsSigma = 1.5;
};

// A two-source variant modelled on ChainedStreamOf, but NOT templated into the
// single-source base: it owns two TapChannels + two TapPublishers. Output is a
// ConvertedFrame carrying a CV_32FC1 disparity mat.
class StereoStream : public ::Stream<ConvertedFrame::Ptr> {
public:
  using Ptr = std::shared_ptr<StereoStream>;
  using Source = std::shared_ptr<::Stream<ConvertedFrame::Ptr>>;

  static Ptr create(Source left, std::string leftId, Source right,
                    std::string rightId, std::string name,
                    const StereoParams &params, uint32_t maxW, uint32_t maxH) {
    return std::make_shared<StereoStream>(
        std::move(left), std::move(leftId), std::move(right),
        std::move(rightId), std::move(name), params, maxW, maxH);
  }
  StereoStream(Source left, std::string leftId, Source right,
               std::string rightId, std::string name,
               const StereoParams &params, uint32_t maxW, uint32_t maxH)
      : left_(std::move(left)), right_(std::move(right)), name_(name),
        leftId_(std::move(leftId)), rightId_(std::move(rightId)), maxW_(maxW),
        maxH_(maxH), params_(params),
        meter_(std::move(name), {"left", "right"}, {"disparity"},
               converterNowMs()) {}

  // stereo-paired-inputs: the PAIRED-input variant — SGBM per PairRecord off the
  // always-running `PairStream` brick (`pairSource`). `pairFrom` is the pair
  // node id (topology input edge `pair/<stage>` → this brick). Compute + output
  // are identical to the latest-wins ctor above.
  using PairSource = std::shared_ptr<::Stream<PairBatch::Ptr>>;
  static Ptr createPaired(PairSource pairSource, std::string pairFrom,
                          std::string name, const StereoParams &params,
                          uint32_t maxW, uint32_t maxH) {
    return std::make_shared<StereoStream>(std::move(pairSource),
                                          std::move(pairFrom), std::move(name),
                                          params, maxW, maxH);
  }
  StereoStream(PairSource pairSource, std::string pairFrom, std::string name,
               const StereoParams &params, uint32_t maxW, uint32_t maxH)
      : name_(name), maxW_(maxW), maxH_(maxH), params_(params), paired_(true),
        pairSource_(std::move(pairSource)), pairFrom_(std::move(pairFrom)),
        meter_(std::move(name), {"left", "right"}, {"disparity"},
               converterNowMs()) {}
  // NB: ::Stream<T>'s destructor is non-virtual, but this brick is only ever
  // held by shared_ptr (its type-erased deleter destructs the concrete type).
  ~StereoStream() {
    closeChains(); // wake a blocked left poll (ChainedStream contract, both ends)
    shutdown();
  }

  // Live retune (reactive params): applied on the NEXT frame (matcher rebuild).
  void setParams(const StereoParams &p) {
    *pending_.ref() = p;
    hasPending_.store(true, std::memory_order_release);
  }

  Meter::Snapshot probe() const { return meter_.probe(converterNowMs()); }
  // The active OUT size + forwarded origin of the LAST produced disparity map
  // (mirrors ScaleStream::activeRect — {originX, originY, w, h}).
  cv::Rect activeRect() const {
    return unpack(activePacked_.load(std::memory_order_acquire));
  }
  const std::string &name() const { return name_; }
  const std::string &leftId() const { return leftId_; }
  const std::string &rightId() const { return rightId_; }
  // stereo-paired-inputs: topology — a paired brick reports ONE input edge from
  // the pair node (`pairFrom`, port "pair"); the latest-wins brick keeps its
  // two left/right edges. `pairDrops` = records shed by the record tap when the
  // SGBM thread outran it (drop-oldest, never backpressures the pair brick).
  bool paired() const { return paired_; }
  const std::string &pairFrom() const { return pairFrom_; }
  uint64_t pairDrops() {
    auto ch = *recCh_.ref();
    return ch ? ch->drops() : 0;
  }

protected:
  void start() override {
    if (paired_)
      return startPaired();
    auto lch = kind_.make();
    auto rch = kind_.make();
    { *leftCh_.ref() = lch; }
    { *rightCh_.ref() = rch; }
    leftPub_ = std::make_unique<TapPublisher>(left_.get(), lch);
    rightPub_ = std::make_unique<TapPublisher>(right_.get(), rch);
    // A terminated source refuses the subscription (state closed immediately).
    if (!leftPub_->state.snapshot().isActive() ||
        !rightPub_->state.snapshot().isActive())
      throw std::runtime_error("stereo chain source stream already terminated");
  }

  void stop() override {
    if (paired_)
      return stopPaired();
    // Close BOTH channels FIRST (ChannelKind::Leaky here, but preserve the
    // ChainedStreamOf deadlock note for both): closing wakes a poll-blocked
    // read (EOS) and, for a FIFO channel, a backpressure-blocked source push,
    // so the source releases its dispatch mutex before we unsubscribe.
    {
      auto ref = leftCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    {
      auto ref = rightCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    leftPub_.reset();  // unsubscribe — source parks if we were its last demand
    rightPub_.reset();
    { *leftCh_.ref() = nullptr; }
    { *rightCh_.ref() = nullptr; }
    lastRight_.reset(); // stale across activations
  }

  ConvertedFrame::Ptr iterate() override {
    if (paired_)
      return iteratePaired();
    TapChannel::Ptr lch, rch;
    {
      auto ref = leftCh_.ref();
      lch = *ref;
    }
    {
      auto ref = rightCh_.ref();
      rch = *ref;
    }
    if (!lch || !rch)
      throw StopIteration();
    // Block on the LEFT channel — the pacing side (caller passes left first).
    OwnedFrame::Ptr left;
    try {
      if (!lch->poll(left, /*wait=*/true))
        return nullptr; // spurious wake (Leaky) — the base yields
    } catch (Threading::EOS &) {
      throw StopIteration(); // left source terminated / our teardown
    }
    if (!left)
      return nullptr;
    // Drain the RIGHT channel non-blocking, keeping only the newest; retain the
    // last-seen right frame across ticks (latest-wins pairing).
    try {
      OwnedFrame::Ptr r;
      while (rch->poll(r, /*wait=*/false))
        lastRight_ = r;
    } catch (Threading::EOS &) {
      throw StopIteration(); // right source terminated
    }
    if (!lastRight_)
      return nullptr; // no right frame yet — skip this left arrival
    return process(left, lastRight_);
  }

private:
  // ---- paired-input transport (stereo-paired-inputs) ------------------------
  // A bounded, DROP-OLDEST record queue. The pair brick's dispatch thread writes
  // (non-blocking — it must NEVER stall the always-running pair brick), the SGBM
  // thread reads (blocking). `close()` wakes a blocked reader (teardown / pair
  // brick death). Records are cheap (2 frame pins + a small anchor), bounded by
  // `cap`; under SGBM overload the OLDEST record is shed (metered as `drops`),
  // never backpressured upstream. GENERALIZED (native-port-pipe.md) into the
  // reusable `Threading::Ring` channel — this alias keeps the local naming; the
  // semantics are byte-for-byte the ring's (test 34 pins the behavior).
  using RecordChannel = Threading::Ring<PairRecord>;

  // The record tap: a Subscriber on the always-running PairStream that fans each
  // completed batch's records into the RecordChannel. Its EXISTENCE is the
  // demand on the pair brick (like TapPublisher on a frame brick). Records are
  // COPIED (2 shared_ptr + a small vector) — the delivered batch is shared with
  // the pair brick's keep-alive (+ any other subscriber), never moved-from here.
  class RecordSink : public Subscriber<PairBatch::Ptr> {
  public:
    RecordSink(::Stream<PairBatch::Ptr> *producer,
               std::shared_ptr<RecordChannel> ch)
        : Subscriber<PairBatch::Ptr>(producer), ch_(std::move(ch)) {}
    ~RecordSink() { close(); }
    void close(bool unsubscribe = true, TracedError::Ptr err = nullptr) override {
      Subscriber<PairBatch::Ptr>::close(unsubscribe, err);
      if (ch_)
        ch_->close(); // downstream read() throws EOS-equivalent (false) → stop
    }

  protected:
    void push(const PairBatch::Ptr &b) override {
      if (!b || !ch_)
        return;
      for (const auto &rec : b->records)
        ch_->write(rec); // COPY the record (pins its two frames)
    }

  private:
    std::shared_ptr<RecordChannel> ch_;
  };

  void startPaired() {
    if (!pairSource_)
      throw std::runtime_error("stereo paired: no pair source");
    auto ch = std::make_shared<RecordChannel>(kPairedRecordCap);
    { *recCh_.ref() = ch; }
    recSub_ = std::make_unique<RecordSink>(pairSource_.get(), ch);
    // A terminated pair brick refuses the subscription (state closed at once).
    if (!recSub_->state.snapshot().isActive())
      throw std::runtime_error("stereo paired source stream already terminated");
  }

  void stopPaired() {
    // Close the channel FIRST (ChainedStream deadlock discipline): wakes an
    // iteratePaired() blocked in read(), then drop the subscriber so the pair
    // brick stops fanning to us (its keep-alive keeps it running — ruling 5).
    {
      auto ref = recCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    recSub_.reset();
    { *recCh_.ref() = nullptr; }
  }

  ConvertedFrame::Ptr iteratePaired() {
    std::shared_ptr<RecordChannel> ch;
    { ch = *recCh_.ref(); }
    if (!ch)
      throw StopIteration();
    PairRecord rec;
    if (!ch->read(rec))
      throw StopIteration(); // channel closed (teardown / pair brick death)
    if (!rec.left || !rec.right)
      return nullptr; // defensive — a record always pins both sides
    // SGBM per pair — L/R matched by construction (no in-brick anchor match).
    return process(rec.left, rec.right);
  }

  ConvertedFrame::Ptr process(const OwnedFrame::Ptr &left,
                              const OwnedFrame::Ptr &right) {
    const int64_t t = converterNowMs();
    // Left ingest + latest-wins drops (this brick outran by the tap).
    if (lastLeftSeq_ && left->seq > lastLeftSeq_ + 1)
      meter_.drop(left->seq - lastLeftSeq_ - 1);
    lastLeftSeq_ = left->seq;
    meter_.ingest("left", t);
    // Right ingest per drained arrival: one consumed + the superseded ones
    // (seq delta) metered as drops (latest-wins — expected under mismatched
    // owner clocks).
    if (right->seq != lastRightSeq_) {
      if (lastRightSeq_ && right->seq > lastRightSeq_ + 1)
        meter_.drop(right->seq - lastRightSeq_ - 1);
      lastRightSeq_ = right->seq;
      meter_.ingest("right", t);
    }

    if (hasPending_.exchange(false, std::memory_order_acquire)) {
      params_ = *pending_.ref();
      matcher_.release(); // rebuilt lazily below with the new params
#ifdef HAVE_OPENCV_XIMGPROC_WLS
      rightMatcher_.release();
      wlsFilter_.release();
#endif
    }

    // Unequal L/R dims → drop (the transient during steering/retune).
    if (left->mat.cols != right->mat.cols ||
        left->mat.rows != right->mat.rows) {
      meter_.drop(); // reason: dims-mismatch
      return nullptr;
    }
    const int iw = left->mat.cols, ih = left->mat.rows;
    if (iw <= 0 || ih <= 0) {
      meter_.drop(); // reason: empty
      return nullptr;
    }

    meter_.begin(t);
    const auto c0 = std::chrono::steady_clock::now();
    if (!matcher_)
      matcher_ = buildMatcher(params_);
    // BGRA → GRAY both sides (both matchers want single-channel 8-bit).
    toGray(left->mat, leftGray_);
    toGray(right->mat, rightGray_);
    // Scaled matching (stereo-throughput.md): match at 1/matchScale — the
    // window was already scaled in buildMatcher; values multiply back below.
    const int s = std::max(1, params_.matchScale);
    const cv::Mat *lg = &leftGray_, *rg = &rightGray_;
    if (s > 1) {
      cv::resize(leftGray_, leftSmall_, cv::Size(), 1.0 / s, 1.0 / s,
                 cv::INTER_AREA);
      cv::resize(rightGray_, rightSmall_, cv::Size(), 1.0 / s, 1.0 / s,
                 cv::INTER_AREA);
      lg = &leftSmall_;
      rg = &rightSmall_;
    }
    matcher_->compute(*lg, *rg, disp16_); // CV_16S fixed-point (match scale)
    const cv::Mat *disp = &disp16_;
#ifdef HAVE_OPENCV_XIMGPROC_WLS
    if (params_.wls) {
      // WLS guided refine (candidate C): a second right-view match feeds the
      // confidence path; the filter is guided by the (match-scale) left gray —
      // guide dims must equal the disparity dims, and the map is EMITTED at
      // match scale, so the scaled view is the honest guide.
      if (!rightMatcher_)
        rightMatcher_ = cv::ximgproc::createRightMatcher(matcher_);
      if (!wlsFilter_) {
        wlsFilter_ = cv::ximgproc::createDisparityWLSFilter(matcher_);
        wlsFilter_->setLambda(params_.wlsLambda);
        wlsFilter_->setSigmaColor(params_.wlsSigma);
      }
      rightMatcher_->compute(*rg, *lg, dispRight16_);
      wlsFilter_->filter(disp16_, *lg, dispFiltered16_, dispRight16_);
      disp = &dispFiltered16_;
    }
#endif
    // Fixed-point → float, VALUES multiplied back to full-res left-frame pixel
    // units (÷16 fixed-point, ×matchScale).
    disp->convertTo(dispF32_, CV_32F, static_cast<double>(s) / 16.0);
    const double processMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - c0)
                                 .count();
    meter_.end(converterNowMs());
    // Active out dims = the EMITTED map's (match-scale) dims; origin stays the
    // LEFT frame's full-res crop origin (values are full-res units).
    activePacked_.store(pack(left->originX, left->originY, dispF32_.cols,
                             dispF32_.rows),
                        std::memory_order_release);

    auto cf = ConvertedFrame::create();
    cf->mat = dispF32_; // header over the reused buffer (ConvertedFrame contract)
    cf->format = left->format;                 // cosmetic (mat.type() is F32)
    cf->deviceTimestamp = left->deviceTimestamp; // trusted-time: never restamp
    cf->systemTimestamp = left->systemTimestamp;
    cf->convertMs = processMs;
    cf->originX = left->originX; // disparity is in LEFT-frame coordinates
    cf->originY = left->originY;
    meter_.emit("disparity", converterNowMs());
    return cf;
  }

  // Build the selected matcher with the window SCALED to the match resolution
  // (numDisparities/scale rounded up to a multiple of 16, minDisparity/scale
  // floored) — values are multiplied back in process().
  static cv::Ptr<cv::StereoMatcher> buildMatcher(const StereoParams &p) {
    const int s = std::max(1, p.matchScale);
    const int nd =
        std::max(16, (((std::max(1, p.numDisparities / s)) + 15) / 16) * 16);
    // Floor division (C++ truncates toward zero) so a negative minDisparity
    // window never loses its most-negative candidates.
    const int minD = static_cast<int>(
        std::floor(static_cast<double>(p.minDisparity) / s));
    if (p.algorithm == StereoAlgorithm::BM) {
      // StereoBM: blockSize must be ODD and >= 5.
      const int bs = std::max(5, p.blockSize | 1);
      auto bm = cv::StereoBM::create(nd, bs);
      bm->setMinDisparity(minD);
      bm->setPreFilterType(cv::StereoBM::PREFILTER_XSOBEL);
      bm->setUniquenessRatio(5);
      bm->setDisp12MaxDiff(1);
      bm->setSpeckleWindowSize(50);
      bm->setSpeckleRange(2);
      return bm;
    }
    const int cn = 1; // grayscale
    const int bs = p.blockSize;
    return cv::StereoSGBM::create(
        minD, nd, bs,
        /*P1=*/8 * cn * bs * bs, /*P2=*/32 * cn * bs * bs,
        /*disp12MaxDiff=*/1, /*preFilterCap=*/0, /*uniquenessRatio=*/5,
        /*speckleWindowSize=*/50, /*speckleRange=*/2, p.mode);
  }
  static void toGray(const cv::Mat &in, cv::Mat &out) {
    if (in.channels() == 4)
      cv::cvtColor(in, out, cv::COLOR_RGBA2GRAY); // pipes are honest RGBA8
    else if (in.channels() == 3)
      cv::cvtColor(in, out, cv::COLOR_RGB2GRAY);
    else
      out = in; // already single-channel
  }
  static uint64_t pack(uint32_t x, uint32_t y, int w, int h) {
    return (static_cast<uint64_t>(static_cast<uint16_t>(x)) << 48) |
           (static_cast<uint64_t>(static_cast<uint16_t>(y)) << 32) |
           (static_cast<uint64_t>(static_cast<uint16_t>(w)) << 16) |
           static_cast<uint64_t>(static_cast<uint16_t>(h));
  }
  static cv::Rect unpack(uint64_t v) {
    return cv::Rect(static_cast<int>((v >> 48) & 0xffff),
                    static_cast<int>((v >> 32) & 0xffff),
                    static_cast<int>((v >> 16) & 0xffff),
                    static_cast<int>(v & 0xffff));
  }

  void closeChains() {
    {
      auto ref = leftCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    {
      auto ref = rightCh_.ref();
      if (*ref)
        (*ref)->close();
    }
    { // paired-input record tap (no-op in latest-wins mode)
      auto ref = recCh_.ref();
      if (*ref)
        (*ref)->close();
    }
  }

  static constexpr size_t kPairedRecordCap = 8; // bounded record tap (view rate)

  const Source left_, right_; // shared: keep the upstream bricks alive
  const std::string name_;
  const std::string leftId_, rightId_; // upstream node ids (topology edges)
  const uint32_t maxW_, maxH_;
  ChannelKind kind_{}; // Leaky (latest-wins) for both inputs

  Threading::Guard<TapChannel::Ptr> leftCh_{nullptr};
  Threading::Guard<TapChannel::Ptr> rightCh_{nullptr};
  std::unique_ptr<TapPublisher> leftPub_;  // exists only while active
  std::unique_ptr<TapPublisher> rightPub_;
  OwnedFrame::Ptr lastRight_; // retained newest right frame (brick thread only)

  // stereo-paired-inputs: the paired-mode input (unused in latest-wins mode).
  const bool paired_ = false;
  const PairSource pairSource_{};  // shared: keeps the pair brick alive
  const std::string pairFrom_;     // pair node id (topology input edge)
  Threading::Guard<std::shared_ptr<RecordChannel>> recCh_{nullptr};
  std::unique_ptr<RecordSink> recSub_; // exists only while active (paired mode)

  Meter::ThreadMeter meter_; // single writer = this brick's thread
  cv::Mat leftGray_, rightGray_, disp16_, dispF32_; // reused buffers (this thread)
  cv::Mat leftSmall_, rightSmall_; // reused 1/matchScale buffers (this thread)
  cv::Ptr<cv::StereoMatcher> matcher_;              // rebuilt on param change
#ifdef HAVE_OPENCV_XIMGPROC_WLS
  cv::Mat dispRight16_, dispFiltered16_; // WLS right-match + refined buffers
  cv::Ptr<cv::StereoMatcher> rightMatcher_;             // WLS confidence path
  cv::Ptr<cv::ximgproc::DisparityWLSFilter> wlsFilter_; // rebuilt on retune
#endif
  StereoParams params_;                             // current spec (this thread)
  Threading::Guard<StereoParams> pending_ = {StereoParams{}};
  std::atomic<bool> hasPending_{false};
  uint64_t lastLeftSeq_ = 0, lastRightSeq_ = 0; // brick thread only
  std::atomic<uint64_t> activePacked_{0};       // last produced {origin, w/h}
};

// Cross-brick lookup (HeatmapStream chains on a stereo pipe): the live stereo
// brick bound to `pipeId`, or nullptr. Defined in StereoStream.cpp (owns the
// registry); NAPI-thread only.
StereoStream::Ptr findStereo(const std::string &pipeId);

} // namespace Arv
