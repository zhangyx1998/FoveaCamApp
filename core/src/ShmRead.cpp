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
  const uint64_t latest = h->latestSeq.load(std::memory_order_acquire);
  if (latest <= lastSeq) {
    // Cold path only: no newer frame. If the publisher has closed the pipe, the
    // final frame was already delivered (its latestSeq is visible before the
    // release-stored CLOSED), so report Closed here — not a frozen last frame.
    if (h->state.load(std::memory_order_acquire) ==
        static_cast<uint32_t>(PipeState::CLOSED))
      return ReadStatus::Closed;
    return ReadStatus::NoNewFrame;
  }
  if (dstBytes < h->slotBytes)
    return ReadStatus::DestTooSmall;

  for (uint32_t retries = 0; retries < MAX_READ_RETRIES; ++retries) {
    const uint32_t slot = h->latestSlot.load(std::memory_order_acquire);
    const SlotHeader *slotHeader = m.slotHeader(slot);
    const uint64_t before = slotHeader->seq.load(std::memory_order_acquire);
    if ((before & 1) != 0 || before == 0)
      continue;
    std::memcpy(dst, m.slotData(slot), h->slotBytes);
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
    out.meta = {tCapture, convertMs, deviceTimestamp, systemTimestamp};
    return ReadStatus::Ok;
  }
  return ReadStatus::TornRead;
}

} // namespace ShmRing
