// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Shared SHM write path (see ShmWrite.h). System-library-only: standard library
// + POSIX shm/mmap. The seqlock publish here is byte-for-byte the logic that
// lived in `ShmRing.cpp`'s `Segment` — extracted verbatim, generalized to a
// per-segment `ringDepth`, plus the v2 `setState` close signal.

#include "ShmWrite.h"

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

Segment::Segment(std::string name, uint32_t generation, int height, int width,
                 int channels, uint32_t ringDepth,
                 const std::function<void(const std::string &)> &onCreate,
                 size_t slotBytesOverride)
    : slotCount_(ringDepth), name(std::move(name)), generation(generation) {
  if (channels <= 0)
    throw std::runtime_error("SHM channels must be positive");
  if (ringDepth < 1 || ringDepth > MAX_SLOT_COUNT)
    throw std::runtime_error("SHM ring depth out of range");
  const size_t slotBytes =
      slotBytesOverride ? slotBytesOverride
                        : static_cast<size_t>(height) *
                              static_cast<size_t>(width) *
                              static_cast<size_t>(channels);
  const size_t dataOffset = alignUp(sizeof(SlotHeader), DATA_ALIGN);
  const size_t slotStride = alignUp(dataOffset + slotBytes, PAGE_ALIGN);
  mappingSize_ =
      alignUp(sizeof(SegmentHeader), PAGE_ALIGN) + slotStride * slotCount_;

  shm_unlink(this->name.c_str());
  fd_ = shm_open(this->name.c_str(), O_CREAT | O_EXCL | O_RDWR, 0600);
  if (fd_ < 0)
    throw std::runtime_error(errnoMessage("shm_open", this->name));
  if (onCreate)
    onCreate(this->name);
  if (ftruncate(fd_, static_cast<off_t>(mappingSize_)) != 0) {
    const auto message = errnoMessage("ftruncate", this->name);
    ::close(fd_);
    fd_ = -1;
    shm_unlink(this->name.c_str());
    throw std::runtime_error(message);
  }
  mapping_ =
      mmap(nullptr, mappingSize_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
  if (mapping_ == MAP_FAILED) {
    const auto message = errnoMessage("mmap", this->name);
    mapping_ = nullptr;
    ::close(fd_);
    fd_ = -1;
    shm_unlink(this->name.c_str());
    throw std::runtime_error(message);
  }

  auto *h = header();
  std::memset(h, 0, sizeof(*h)); // state defaults to OPEN (0)
  std::memcpy(h->magic, MAGIC, sizeof(MAGIC));
  h->layoutVersion = LAYOUT_VERSION;
  h->generation = generation;
  h->width = static_cast<uint32_t>(width);
  h->height = static_cast<uint32_t>(height);
  h->channels = static_cast<uint32_t>(channels);
  h->slotCount = slotCount_;
  h->slotBytes = slotBytes;
  h->slotStride = slotStride;
  h->dataOffset = dataOffset;
  h->latestSeq.store(0, std::memory_order_release);
  h->latestSlot.store(0, std::memory_order_release);
  h->state.store(static_cast<uint32_t>(PipeState::OPEN),
                 std::memory_order_release);
  for (uint32_t i = 0; i < slotCount_; ++i)
    slotHeader(i)->seq.store(0, std::memory_order_release);
}

Segment::~Segment() {
  if (mapping_)
    munmap(mapping_, mappingSize_);
  if (fd_ >= 0)
    ::close(fd_);
  shm_unlink(name.c_str());
}

SegmentHeader *Segment::header() const {
  return reinterpret_cast<SegmentHeader *>(mapping_);
}

SlotHeader *Segment::slotHeader(uint32_t slot) const {
  auto *base = static_cast<std::byte *>(mapping_) +
               alignUp(sizeof(SegmentHeader), PAGE_ALIGN) +
               header()->slotStride * slot;
  return reinterpret_cast<SlotHeader *>(base);
}

void *Segment::slotData(uint32_t slot) const {
  return reinterpret_cast<std::byte *>(slotHeader(slot)) + header()->dataOffset;
}

uint32_t Segment::beginSlot() {
  const uint32_t prev = header()->latestSlot.load(std::memory_order_acquire);
  const uint32_t slot = (prev + 1) % slotCount_;
  const uint64_t latest = header()->latestSeq.load(std::memory_order_acquire);
  slotHeader(slot)->seq.store(latest * 2 + 1, std::memory_order_release);
  std::atomic_thread_fence(std::memory_order_seq_cst);
  return slot;
}

uint64_t Segment::publish(uint32_t slot, const FrameMeta &meta,
                          uint32_t activeWidth, uint32_t activeHeight) {
  const uint64_t seq = header()->latestSeq.load(std::memory_order_acquire) + 1;
  auto *s = slotHeader(slot);
  s->tCapture = meta.tCapture;
  s->convertMs = meta.convertMs;
  s->deviceTimestamp = meta.deviceTimestamp;
  s->systemTimestamp = meta.systemTimestamp;
  s->width = activeWidth ? activeWidth : header()->width;
  s->height = activeHeight ? activeHeight : header()->height;
  s->seq.store(seq * 2, std::memory_order_release);
  header()->latestSlot.store(slot, std::memory_order_release);
  header()->latestSeq.store(seq, std::memory_order_release);
  return seq;
}

void Segment::setState(PipeState state) {
  header()->state.store(static_cast<uint32_t>(state), std::memory_order_release);
}

} // namespace ShmRing
