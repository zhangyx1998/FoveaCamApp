// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared SHM read path (see ShmRead.h). System-library-only: standard library +
// POSIX shm/mmap. Do NOT add N-API / OpenCV / Aravis / GLib / libusb includes —
// this compiles into the sandboxed reader addon, which links `napi` alone.

#include "ShmRead.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <sys/mman.h>
#include <unistd.h>

namespace ShmRing {
namespace {

std::string errnoMessage(const char *action, const std::string &name) {
  return std::string(action) + " " + name + ": " + std::strerror(errno);
}

} // namespace

ReadMapping::ReadMapping(const std::string &name) {
  fd_ = shm_open(name.c_str(), O_RDONLY, 0);
  if (fd_ < 0)
    throw std::runtime_error(errnoMessage("shm_open", name));
  // Map just the header page first to read the layout, then remap the full
  // segment once slotStride/slotCount are known.
  void *firstPage = mmap(nullptr, PAGE_ALIGN, PROT_READ, MAP_SHARED, fd_, 0);
  if (firstPage == MAP_FAILED) {
    ::close(fd_);
    fd_ = -1;
    throw std::runtime_error(errnoMessage("mmap header", name));
  }
  auto *h = reinterpret_cast<SegmentHeader *>(firstPage);
  // slotCount is per-segment (pipes carry their own ringDepth); validate a sane
  // range rather than a fixed value.
  if (std::memcmp(h->magic, MAGIC, sizeof(MAGIC)) != 0 ||
      h->layoutVersion != LAYOUT_VERSION || h->slotCount < 1 ||
      h->slotCount > MAX_SLOT_COUNT) {
    munmap(firstPage, PAGE_ALIGN);
    ::close(fd_);
    fd_ = -1;
    throw std::runtime_error("Invalid Fovea SHM segment header");
  }
  mappingSize_ =
      alignUp(sizeof(SegmentHeader), PAGE_ALIGN) + h->slotStride * h->slotCount;
  munmap(firstPage, PAGE_ALIGN);
  mapping_ = mmap(nullptr, mappingSize_, PROT_READ, MAP_SHARED, fd_, 0);
  if (mapping_ == MAP_FAILED) {
    mapping_ = nullptr;
    ::close(fd_);
    fd_ = -1;
    throw std::runtime_error(errnoMessage("mmap", name));
  }
}

ReadMapping::~ReadMapping() { close(); }

void ReadMapping::close() {
  if (mapping_) {
    munmap(mapping_, mappingSize_);
    mapping_ = nullptr;
  }
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
}

const SegmentHeader *ReadMapping::header() const {
  if (!mapping_)
    throw std::runtime_error("SHM reader is closed");
  return reinterpret_cast<const SegmentHeader *>(mapping_);
}

const SlotHeader *ReadMapping::slotHeader(uint32_t slot) const {
  const auto *base = static_cast<const std::byte *>(mapping_) +
                     alignUp(sizeof(SegmentHeader), PAGE_ALIGN) +
                     header()->slotStride * slot;
  return reinterpret_cast<const SlotHeader *>(base);
}

const void *ReadMapping::slotData(uint32_t slot) const {
  return reinterpret_cast<const std::byte *>(slotHeader(slot)) +
         header()->dataOffset;
}

ReadStatus readLatestInto(const ReadMapping &m, void *dst, size_t dstBytes,
                          uint64_t lastSeq, ReadResult &out) {
  const SegmentHeader *h = m.header();
  uint64_t latest = h->latestSeq.load(std::memory_order_acquire);
  if (latest <= lastSeq) {
    // Cold path only: no newer frame. If the publisher has closed the pipe, the
    // final frame was already delivered (its latestSeq is visible before the
    // release-stored CLOSED), so report Closed here — not a frozen last frame.
    const bool closed = h->state.load(std::memory_order_acquire) ==
                        static_cast<uint32_t>(PipeState::CLOSED);
    // Close/publish race: our `latest` load may predate the writer's FINAL
    // publish while our `state` load observes CLOSED (the two loads can straddle
    // a preemption). The CLOSED store is release-ordered AFTER that publish, so
    // observing CLOSED lets a RE-LOAD of latestSeq see the final value — re-read
    // and re-check so a frame published concurrently with close is never lost.
    if (closed)
      latest = h->latestSeq.load(std::memory_order_acquire);
    if (latest <= lastSeq)
      return closed ? ReadStatus::Closed : ReadStatus::NoNewFrame;
    // else: a newer frame WAS published before close — fall through and read it.
  }
  // DestTooSmall is now checked INSIDE the seqlock window against the ACTUAL
  // copied length (v5: `payloadBytes` when nonzero, else the full slot) — a
  // consumer sized to a compressed blob (< slotBytes) is no longer rejected.

  for (uint32_t retries = 0; retries < MAX_READ_RETRIES; ++retries) {
    const uint32_t slot = h->latestSlot.load(std::memory_order_acquire);
    const SlotHeader *slotHeader = m.slotHeader(slot);
    const uint64_t before = slotHeader->seq.load(std::memory_order_acquire);
    if ((before & 1) != 0 || before == 0)
      continue;
    // v5: the actual copy length. Clamp payloadBytes to slotBytes so a TORN read
    // (garbage payloadBytes) can never over-read the slot mapping before the
    // post-check discards it; a valid payloadBytes is always ≤ slotBytes.
    const uint64_t payloadBytes = slotHeader->payloadBytes;
    const size_t copyBytes =
        payloadBytes ? std::min<size_t>(payloadBytes, h->slotBytes)
                     : h->slotBytes;
    if (dstBytes < copyBytes) {
      // Might be a torn read (garbage payloadBytes) — validate the seqlock before
      // reporting; a clean read means the destination is genuinely too small.
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint64_t chk = slotHeader->seq.load(std::memory_order_acquire);
      if (before != chk || (chk & 1) != 0)
        continue;
      return ReadStatus::DestTooSmall;
    }
    std::memcpy(dst, m.slotData(slot), copyBytes);
    const double tCapture = slotHeader->tCapture;
    const double convertMs = slotHeader->convertMs;
    const uint64_t deviceTimestamp = slotHeader->deviceTimestamp;
    const uint64_t systemTimestamp = slotHeader->systemTimestamp;
    const uint32_t width = slotHeader->width;
    const uint32_t height = slotHeader->height;
    const uint32_t originX = slotHeader->originX; // v4 (read inside the seqlock
    const uint32_t originY = slotHeader->originY; // window, like width/height)
    std::atomic_thread_fence(std::memory_order_acquire);
    const uint64_t after = slotHeader->seq.load(std::memory_order_acquire);
    if (before != after || (after & 1) != 0)
      continue;

    out.seq = after / 2;
    out.gen = h->generation;
    out.retries = retries;
    out.width = width;
    out.height = height;
    out.originX = originX;
    out.originY = originY;
    out.payloadBytes = payloadBytes; // v5: 0 (dims-derived) or the actual length
    out.meta = {tCapture, convertMs, deviceTimestamp, systemTimestamp};
    return ReadStatus::Ok;
  }
  return ReadStatus::TornRead;
}

ReadStatus readSeqInto(const ReadMapping &m, uint64_t wantSeq, void *dst,
                       size_t dstBytes, ReadResult &out) {
  const SegmentHeader *h = m.header();
  const uint32_t slotCount = h->slotCount;
  if (slotCount == 0)
    return ReadStatus::TornRead; // defensive (open() validates slotCount >= 1)

  uint64_t latest = h->latestSeq.load(std::memory_order_acquire);
  if (wantSeq == 0 || wantSeq > latest) {
    // The requested frame has not been published yet. If the publisher has
    // closed the pipe, no newer frame will ever arrive (latestSeq is visible
    // before the release-stored CLOSED), so report Closed — the FIFO consumer
    // drains up to latestSeq, then stops. Otherwise NotYet (poll again).
    const bool closed = h->state.load(std::memory_order_acquire) ==
                        static_cast<uint32_t>(PipeState::CLOSED);
    // Close/publish race (see readLatestInto): our `latest` load may predate the
    // writer's FINAL publish while `state` observes CLOSED. CLOSED is release-
    // ordered after that publish, so re-load latestSeq once we've seen CLOSED
    // and re-check — a frame published concurrently with close stays deliverable
    // (never falsely NotYet→Closed) so the recorder keeps its last frame.
    if (closed)
      latest = h->latestSeq.load(std::memory_order_acquire);
    if (wantSeq == 0 || wantSeq > latest)
      return closed ? ReadStatus::Closed : ReadStatus::NotYet;
    // else: wantSeq was published before close — fall through and read the slot.
  }
  // DestTooSmall is checked INSIDE the seqlock window against the ACTUAL copied
  // length (v5 payloadBytes), like readLatestInto.

  // Round-robin invariant (ShmWrite): seq N occupies slot N % slotCount.
  const uint32_t slot = static_cast<uint32_t>(wantSeq % slotCount);
  for (uint32_t retries = 0; retries < MAX_READ_RETRIES; ++retries) {
    const SlotHeader *slotHeader = m.slotHeader(slot);
    const uint64_t before = slotHeader->seq.load(std::memory_order_acquire);
    if ((before & 1) != 0 || before == 0)
      continue; // writer mid-fill (odd) or never written — retry
    const uint64_t stable = before / 2;
    if (stable != wantSeq) {
      // `wantSeq <= latest` means the writer published `wantSeq` into this slot
      // at least once; the slot can therefore only hold a NEWER recycled frame
      // (stable == wantSeq + k*slotCount, k >= 1) — `wantSeq` is Gone. Report
      // the oldest still-live seq (`latest - slotCount + 1`, clamped to 1) so
      // the consumer jumps forward and accounts the gap as drops.
      const uint64_t latestNow = h->latestSeq.load(std::memory_order_acquire);
      out.oldestSeq =
          latestNow >= slotCount ? latestNow - slotCount + 1 : 1;
      return ReadStatus::Gone;
    }
    // The slot still holds `wantSeq` — seqlock-copy it (same discipline as
    // readLatestInto: acquire fence between the copy and the post-check).
    // v5: copy the ACTUAL payload length (clamped to slotBytes for torn-read
    // safety); DestTooSmall against it, validated against the seqlock.
    const uint64_t payloadBytes = slotHeader->payloadBytes;
    const size_t copyBytes =
        payloadBytes ? std::min<size_t>(payloadBytes, h->slotBytes)
                     : h->slotBytes;
    if (dstBytes < copyBytes) {
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint64_t chk = slotHeader->seq.load(std::memory_order_acquire);
      if (before != chk || (chk & 1) != 0)
        continue; // torn — retry
      return ReadStatus::DestTooSmall;
    }
    std::memcpy(dst, m.slotData(slot), copyBytes);
    const double tCapture = slotHeader->tCapture;
    const double convertMs = slotHeader->convertMs;
    const uint64_t deviceTimestamp = slotHeader->deviceTimestamp;
    const uint64_t systemTimestamp = slotHeader->systemTimestamp;
    const uint32_t width = slotHeader->width;
    const uint32_t height = slotHeader->height;
    const uint32_t originX = slotHeader->originX;
    const uint32_t originY = slotHeader->originY;
    std::atomic_thread_fence(std::memory_order_acquire);
    const uint64_t after = slotHeader->seq.load(std::memory_order_acquire);
    if (before != after || (after & 1) != 0)
      continue; // the writer recycled this slot mid-copy — retry

    out.seq = wantSeq;
    out.gen = h->generation;
    out.retries = retries;
    out.width = width;
    out.height = height;
    out.originX = originX;
    out.originY = originY;
    out.payloadBytes = payloadBytes; // v5: 0 (dims-derived) or the actual length
    out.oldestSeq = 0;
    out.meta = {tCapture, convertMs, deviceTimestamp, systemTimestamp};
    return ReadStatus::Ok;
  }
  return ReadStatus::TornRead;
}

} // namespace ShmRing
