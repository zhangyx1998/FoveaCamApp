// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// The single home for the Fovea SHM WRITE path — the RW segment mapping +
// header init + seqlock publish. Extracted from `ShmRing.cpp` (C-16) so both
// the live preview `WriterCore` and the new pipe `Publisher` share ONE writer
// (mirrors the `ShmRead` read-side split). The seqlock discipline lives here
// once; a fix lands on every writer at the same time.
//
// System-library-only (ShmLayout + libc/POSIX); no N-API / OpenCV / Aravis /
// GLib / libusb — safe to compile anywhere the layout is used. Naming, the
// topic-key collision registry, and the boot sweep stay in `ShmRing.cpp`; a
// caller passes a pre-formed segment name and an optional on-create hook (the
// live path records it in the sweep manifest).

#include <cstdint>
#include <functional>
#include <string>

#include "ShmLayout.h"

namespace ShmRing {

/** One RW-mapped SHM segment — the writer side of the ring. Creates the POSIX
 *  segment (`O_CREAT|O_EXCL`), maps it, and initializes the header for
 *  `ringDepth` slots. Throws `std::runtime_error` on any failure (message
 *  preserves the errno action). */
class Segment {
  int fd_ = -1;
  void *mapping_ = nullptr;
  size_t mappingSize_ = 0;
  uint32_t slotCount_ = 0;

public:
  const std::string name;
  const uint32_t generation;

  /** `onCreate` (nullable) runs right after the segment is created — the live
   *  path records the name in the boot-sweep manifest; pipes pass nullptr.
   *  `slotBytesOverride` sizes each slot explicitly (pipes pass
   *  `PipeSpec.bytesPerFrame`, which for U16/packed formats exceeds
   *  height*width*channels); 0 = compute height*width*channels (live path). */
  Segment(std::string name, uint32_t generation, int height, int width,
          int channels, uint32_t ringDepth,
          const std::function<void(const std::string &)> &onCreate = {},
          size_t slotBytesOverride = 0);
  ~Segment();
  Segment(const Segment &) = delete;
  Segment &operator=(const Segment &) = delete;

  SegmentHeader *header() const;
  SlotHeader *slotHeader(uint32_t slot) const;
  void *slotData(uint32_t slot) const;

  /** Open the next slot for writing (odd seqlock value). */
  uint32_t beginSlot();
  /** Publish the filled `slot` as the latest frame; returns its stable seq.
   *  `activeWidth/activeHeight` (v3) record the frame's live size within a
   *  MAX-sized ring; 0 = use the segment's header dimensions (live writer). */
  uint64_t publish(uint32_t slot, const FrameMeta &meta,
                   uint32_t activeWidth = 0, uint32_t activeHeight = 0);
  /** Release-ordered `state` store — the symmetric-close signal (C-16). Call
   *  after the final `publish()`; consumers observe it on their next read. */
  void setState(PipeState state);
};

} // namespace ShmRing
