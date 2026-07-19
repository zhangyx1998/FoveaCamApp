// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// The single home for the Fovea SHM READ path — mapping open + header
// validation + slot addressing + the seqlock read. Compiled into BOTH the core
// target and the sandboxed reader addon so the hard memory-ordering logic
// (the seqlock/read-window races) lives in one place and a fix lands on both
// sides at once.
//
// HARD CONSTRAINT: this TU is system-library-only. It includes only
// `ShmLayout.h` + the C++ standard library / POSIX (mmap, shm_open) — NO
// N-API, OpenCV, Aravis, GLib, or libusb. The reader addon links `napi` alone;
// the N-API glue that turns a `ReadResult` into a JS object stays in
// `reader/ShmReaderAddon.cpp`.

#include <cstddef>
#include <cstdint>
#include <string>

#include "ShmLayout.h"

namespace ShmRing {

// `FrameMeta` lives in ShmLayout.h (shared with the write TU).

/** Result of a successful `readLatestInto` (the seqlock-stable frame). */
struct ReadResult {
  uint64_t seq = 0;   // stable frame sequence (header value / 2)
  uint32_t gen = 0;   // segment generation
  uint32_t retries = 0; // seqlock retries this read took
  uint32_t width = 0;   // v3: active frame width (≤ segment max)
  uint32_t height = 0;  // v3: active frame height
  uint32_t originX = 0; // v4: frame-bound crop origin in the parent stream
  uint32_t originY = 0; // (0/0 for uncropped streams)
  // v5: the ACTUAL payload byte length the read COPIED into `dst` when the slot
  // records one (compression bricks); 0 = the slot left it unset and the copy
  // was the dim-derived / full-slot count (every uncompressed producer).
  uint64_t payloadBytes = 0;
  // FIFO (`readSeqInto` → `Gone`): the OLDEST still-live seq the consumer
  // should jump to (it accounts `wantSeq .. oldestSeq-1` as drops). 0 otherwise.
  uint64_t oldestSeq = 0;
  FrameMeta meta;
};

/** Outcome of `readLatestInto` / `readSeqInto`. Only `Ok` fills the pixel copy
 *  + the `seq/gen/width/...` fields; `Gone` fills only `out.oldestSeq`. */
enum class ReadStatus {
  Ok,          // fresh frame copied, `out` populated
  NoNewFrame,  // latestSeq <= lastSeq — nothing newer to read (pipe still OPEN)
  DestTooSmall, // destination smaller than the slot's frame bytes
  TornRead,    // MAX_READ_RETRIES seqlock attempts all raced the writer
  Closed,      // no new frame AND the publisher set state=CLOSED — the
               // final frame was already delivered; consumer should unmap
  // ---- FIFO-mode outcomes (readSeqInto only) ----
  NotYet,      // wantSeq > latestSeq — the requested frame is not published yet
               // (pipe still OPEN); the consumer short-polls/backs off and retries
  Gone,        // wantSeq's ring slot was already recycled by a newer frame — the
               // consumer lagged a full ring. `out.oldestSeq` = the oldest seq
               // still live: JUMP there, account `wantSeq..oldestSeq-1` as drops
};

/** RAII read-only mapping over a published Fovea SHM segment. Opens the named
 *  segment `O_RDONLY`, validates the header (magic / layoutVersion / slotCount),
 *  and maps the full segment. Throws `std::runtime_error` on open / mmap /
 *  validation failure (message preserves the errno action, e.g. "shm_open …"). */
class ReadMapping {
  int fd_ = -1;
  void *mapping_ = nullptr;
  size_t mappingSize_ = 0;

public:
  explicit ReadMapping(const std::string &name);
  ~ReadMapping();
  ReadMapping(const ReadMapping &) = delete;
  ReadMapping &operator=(const ReadMapping &) = delete;

  void close();
  bool isOpen() const { return mapping_ != nullptr; }

  const SegmentHeader *header() const;
  const SlotHeader *slotHeader(uint32_t slot) const;
  const void *slotData(uint32_t slot) const;
};

/** Seqlock read of the latest published frame into `dst` (capacity `dstBytes`).
 *  Preserves the acquire loads + the `atomic_thread_fence(acquire)` between the
 *  pixel/meta copy and the post-check, the odd/zero seqlock guards, and the
 *  `MAX_READ_RETRIES` cap. On `Ok`, `out` carries seq/gen/retries/meta. */
ReadStatus readLatestInto(const ReadMapping &m, void *dst, size_t dstBytes,
                          uint64_t lastSeq, ReadResult &out);

/** FIFO-mode seqlock read of a SPECIFIC frame `wantSeq` into `dst` (capacity
 *  `dstBytes`). The consumer drives an ordered, lossless-within-a-ring stream by
 *  reading `lastDelivered+1` each step. Slot addressing exploits the writer's
 *  round-robin invariant (`ShmWrite`: `latestSlot` and `latestSeq` both advance
 *  by exactly 1 per publish from 0/0) → frame `wantSeq` lives in slot
 *  `wantSeq % slotCount`. Outcomes:
 *    - `Ok`      slot still holds `wantSeq` → copied, `out` populated (as
 *                readLatestInto, with `out.seq == wantSeq`).
 *    - `NotYet`  `wantSeq > latestSeq` (or `wantSeq == 0`) — not published yet.
 *    - `Gone`    the slot was recycled past `wantSeq` (consumer lagged a full
 *                ring) → `out.oldestSeq` = the oldest live seq to jump to.
 *    - `Closed`  `wantSeq` beyond `latestSeq` AND the publisher set CLOSED.
 *    - `DestTooSmall` / `TornRead` as readLatestInto.
 *  Same seqlock retry discipline + DestTooSmall (`dstBytes >= slotBytes`)
 *  as `readLatestInto`; never blocks the writer. */
ReadStatus readSeqInto(const ReadMapping &m, uint64_t wantSeq, void *dst,
                       size_t dstBytes, ReadResult &out);

} // namespace ShmRing
