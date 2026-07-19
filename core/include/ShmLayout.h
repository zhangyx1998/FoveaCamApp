// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// The Fovea SHM segment binary layout — constants and POD header structs
// shared by the writer (core target, `ShmRing.cpp`), the read path
// (`ShmRead.{h,cpp}`), and the sandboxed reader addon. Deliberately
// dependency-free: standard library only, NO N-API / OpenCV / Aravis / GLib /
// libusb, so it is safe to compile into the reader addon (which links `napi`
// alone). Kept separate from `ShmRing.h` (which pulls in `<napi.h>`) so the
// read TU can share the layout without dragging N-API into a libc-only unit.

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace ShmRing {

static constexpr char MAGIC[8] = {'F', 'V', 'S', 'H', 'M', 'R', 'G', '\0'};
// v2: SegmentHeader gains the `state` word (OPEN|CLOSED) for symmetric
// pipe close. v3: SlotHeader gains per-frame active `width/height` so a
// dynamic fovea pipe can carry a varying active size inside a MAX-sized ring
// (the consumer reads the active size per frame). v4: SlotHeader
// gains per-frame crop `originX/originY` — a fovea crop's position in its
// parent stream, FRAME-BOUND like the active size (a JS-side rect echo races
// frame timing). v5: SlotHeader gains per-frame `payloadBytes` — the ACTUAL
// byte length of this slot's payload (compression bricks emit variable-length
// blobs); 0 = derive from dims (the live/uncompressed writers leave it 0).
// Single process — writer + reader share this header, rebuilt together, so
// there is no version skew.
static constexpr uint32_t LAYOUT_VERSION = 5;
// Default ring depth of the live preview writer (unchanged). Pipes carry their
// own `ringDepth` in the segment header's `slotCount`; the reader validates it
// against [1, MAX_SLOT_COUNT] rather than a fixed value.
static constexpr uint32_t SLOT_COUNT = 3;
static constexpr uint32_t MAX_SLOT_COUNT = 64;
static constexpr size_t PAGE_ALIGN = 16 * 1024;
static constexpr size_t DATA_ALIGN = 64;
static constexpr uint32_t MAX_READ_RETRIES = 8;

/** Pipe lifecycle state stored in the segment header. A consumer
 *  reads it only on the cold "no new frame" path, so the final frame is always
 *  delivered before CLOSED is observed — an explicit signal, not a frozen last
 *  frame. Written by the publisher with a release store, read with acquire. */
enum class PipeState : uint32_t { OPEN = 0, CLOSED = 1 };

/** Per-frame metadata carried in each slot (shared by the read and write TUs). */
struct FrameMeta {
  double tCapture = 0;
  double convertMs = 0;
  uint64_t deviceTimestamp = 0;
  uint64_t systemTimestamp = 0;
};

// Boot sweep policy: FoveaCam runs a single orchestrator process. On startup,
// it may unlink every Fovea-owned `/fv.*` segment before creating new writers;
// live readers keep their existing mappings, but no new reader can attach to
// the orphaned names. Platforms with enumerable POSIX SHM namespaces sweep
// `/fv.*` directly; platforms without that support use the writer manifest.

inline size_t alignUp(size_t value, size_t alignment) {
  return (value + alignment - 1) / alignment * alignment;
}

struct alignas(64) SegmentHeader {
  char magic[8];
  uint32_t layoutVersion;
  uint32_t generation;
  uint32_t width;
  uint32_t height;
  uint32_t channels;
  uint32_t slotCount;
  uint64_t slotBytes;
  uint64_t slotStride;
  uint64_t dataOffset;
  std::atomic<uint64_t> latestSeq;
  std::atomic<uint32_t> latestSlot;
  // v2: appended so existing field offsets are unchanged. 0 = OPEN
  // (memset default), 1 = CLOSED. Only pipe publishers ever store CLOSED; the
  // live preview writer leaves it OPEN, so its readers never take the closed
  // path — zero behavior change to the live path.
  std::atomic<uint32_t> state;
};

struct alignas(64) SlotHeader {
  // Seqlock value: odd while a writer is filling the slot, even when stable.
  // Stable frame sequence exposed to JS is seq / 2.
  std::atomic<uint64_t> seq;
  double tCapture;
  double convertMs;
  uint64_t deviceTimestamp;
  uint64_t systemTimestamp;
  // v3: active frame size for this slot (≤ the segment's max dims), so a
  // dynamic fovea pipe carries a varying size inside a MAX-sized ring. The live
  // writer leaves them = the segment's fixed dims (publish's defaulted args).
  uint32_t width;
  uint32_t height;
  // v4: this frame's crop origin within its PARENT stream (fovea
  // crop nodes). 0/0 for uncropped streams (publish's defaulted args).
  uint32_t originX;
  uint32_t originY;
  // v5: the ACTUAL payload byte length in this
  // slot. Compression bricks emit variable-length blobs, so the reader copies
  // exactly this many bytes and surfaces it to the consumer instead of the
  // dim-derived count. 0 = derive from dims (every live/uncompressed writer —
  // publish's defaulted arg). Read UNDER the seqlock like width/height. Appended
  // at offset 56 (uint64-aligned); dataOffset (alignUp(sizeof,64)) is unchanged,
  // so the payload region and every existing field offset are identical.
  uint64_t payloadBytes;
};

} // namespace ShmRing
