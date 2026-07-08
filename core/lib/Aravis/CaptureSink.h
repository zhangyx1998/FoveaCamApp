// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// WS1 real-1c B-side (B-16): the Aravis capture → SHM pipe producer. B owns the
// per-camera capture thread — the existing `Arv::Stream` thread, which pops the
// ArvBuffer, `Frame::create`-copies it (extract-before-release satisfied) and
// releases the buffer, then fans the `Frame::Ptr` out to subscribers. This adds
// ONE more subscriber that converts the frame to the pipe's BGRA8 format into a
// REUSABLE buffer and `offer()`s it to C's `FrameSink` (Pipe.h). Vision
// view-taps are co-subscribers on the same thread — unaffected. C's publisher
// collapsed into `offer()` (runs on this producer thread, off the JS loop) and
// records the pipe's `ThreadMeter` itself, incl. the `convertMs` we pass.

#include <cstdint>

#include <opencv2/opencv.hpp>

#include <Pipe.h> // C's producer-sink interface (FrameSink/FrameInfo) + ShmRing::FrameMeta

#include "Frame.h"  // Arv::Frame, PixelFormat, cvtColorCode, BGRA8
#include "Stream.h" // Arv::Stream, Subscriber<Frame::Ptr>

namespace Arv {

// Convert `raw` (in `format`) to BGRA8 into the reusable `dst` Mat (no per-frame
// allocation once size/type are stable) and `offer()` it to C's `sink`.
// GEOMETRY GUARD: a frame whose width/height doesn't match the pipe's advertised
// `expWidth`/`expHeight` is DROPPED (returns false, no offer) — a size/format
// change means A re-advertises a fresh pipe; we must never offer bytes that
// mismatch the ring's `bytesPerFrame`. Fills `FrameMeta` from the Aravis
// timestamps + the measured convert time. Returns true iff a frame was offered.
//
// Frame-release hazard is a non-issue at this point: `raw` is already a heap
// copy (Frame::fromArvBuffer) and the ArvBuffer was pushed back by
// Stream::iterate before any subscriber ran — we never touch Aravis memory.
bool feedPipe(Pipe::FrameSink &sink, const cv::Mat &raw, PixelFormat format,
              uint64_t deviceTimestamp, uint64_t systemTimestamp, cv::Mat &dst,
              uint32_t expWidth, uint32_t expHeight);

// A `Subscriber` on one camera's `Arv::Stream` that feeds a single pipe. Held as
// a `Shared<CaptureSink>` (`create(stream, sink, w, h)`); the JS cut-over
// (A's registry, out of scope here) creates one per connected camera pipe and
// drops it on disconnect. `stream_` keeps the stream alive while subscribed; the
// destructor unsubscribes before it releases.
class CaptureSink : public Subscriber<Frame::Ptr>, public Shared<CaptureSink> {
public:
  CaptureSink(const Arv::Stream::Ptr &stream, Pipe::FrameSink *sink,
              uint32_t width, uint32_t height)
      : Subscriber<Frame::Ptr>(stream.get()), stream_(stream), sink_(sink),
        width_(width), height_(height) {}

  // Unsubscribe while stream_ is still held (members destruct after this body;
  // the base ~Subscriber then close()s idempotently). Deletion is type-correct
  // via the Shared<> shared_ptr even though ~Subscriber is non-virtual.
  ~CaptureSink() { Subscriber<Frame::Ptr>::close(); }

protected:
  // Runs on the Arv::Stream thread. `frame` is already extracted + released.
  void push(const Frame::Ptr &frame) override {
    if (frame && sink_)
      feedPipe(*sink_, frame->raw, frame->format, frame->device_timestamp,
               frame->system_timestamp, bgra_, width_, height_);
  }

private:
  const Arv::Stream::Ptr stream_;
  Pipe::FrameSink *const sink_;
  const uint32_t width_;
  const uint32_t height_;
  cv::Mat bgra_; // reusable BGRA8 conversion target
};

} // namespace Arv
