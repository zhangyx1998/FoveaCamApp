// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <arv.h>

#include <Stream/Stream.h>
#include <pointer.h>
#include <utils/ref-count.h>

#include "Camera.h"
#include "Frame.h"

namespace Arv {

class Stream : public ::Stream<Frame::Ptr> {
public:
  typedef RefCount::Reference<Stream> Ptr;
  static Ptr get(Camera::Ptr camera);

  // Pre-Frame ArvBuffer tap. `Frame`
  // construction UNPACKS packed 12p into a 16-bit container, so the VERBATIM
  // packed wire payload exists ONLY between the buffer pop and its requeue
  // inside iterate(). A tap is a synchronous callback fired there — BEFORE
  // Frame::create (the unpack) and BEFORE arv_stream_push_buffer (the requeue)
  // — the "extract before release" discipline at the ArvBuffer level. The
  // Frame::Ptr Subscriber fan-out (RawPipe's post-unpack `frame->raw` tap)
  // cannot see these bytes; only this hook can. Gated: with no taps registered,
  // iterate() pays a single relaxed-atomic load + branch (zero capture-thread
  // cost when no raw12p pipe is connected).
  class BufferTap {
  public:
    virtual ~BufferTap() = default;
    // `clockOffsetNs` = the owning camera's calibrated device→host dt for THIS
    // frame (the SAME value handed to Frame::create this iterate), so a tap's
    // deviceTimestamp matches the Frame path exactly (trusted-time: the owner
    // thread applies the calibrated dt at the source, never restamped later).
    virtual void onBuffer(ArvBuffer *buffer, int64_t clockOffsetNs) = 0;
  };
  // Register/unregister a buffer tap (NAPI thread; both idempotent). The tap
  // pointer must outlive its registration (removeBufferTap before destruction).
  void addBufferTap(BufferTap *tap);
  void removeBufferTap(BufferTap *tap);

  const Camera::Ptr camera;
  Stream(const Camera::Ptr &camera);
  ~Stream();

private:
  ArvStream *stream = nullptr;
  // Buffer-tap registry. `tapCount_` is the lock-free fast-path gate read once
  // per iterate() (relaxed — a newly (un)registered tap taking effect one frame
  // late is harmless); `tapMutex_` guards the set for the rare (un)register and
  // the active-frame dispatch.
  std::mutex tapMutex_;
  Set<BufferTap *> bufferTaps_;
  std::atomic<uint32_t> tapCount_{0};
  void dispatchBufferTaps(ArvBuffer *buffer, int64_t clockOffsetNs);
  void start() override;
  void stop() override;
  Frame::Ptr iterate() override;
};

} // namespace Arv
