// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <napi.h>

namespace ShmRing {

static constexpr char MAGIC[8] = {'F', 'V', 'S', 'H', 'M', 'R', 'G', '\0'};
static constexpr uint32_t LAYOUT_VERSION = 1;
static constexpr uint32_t SLOT_COUNT = 3;
static constexpr size_t PAGE_ALIGN = 16 * 1024;
static constexpr size_t DATA_ALIGN = 64;
static constexpr uint32_t MAX_READ_RETRIES = 8;

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
};

struct alignas(64) SlotHeader {
  // Seqlock value: odd while a writer is filling the slot, even when stable.
  // Stable frame sequence exposed to JS is seq / 2.
  std::atomic<uint64_t> seq;
  double tCapture;
  double convertMs;
  uint64_t deviceTimestamp;
  uint64_t systemTimestamp;
};

struct WriteTarget {
  void *data = nullptr;
  size_t bytes = 0;
  std::vector<int> shape;
  int channels = 0;
  std::shared_ptr<void> keepAlive;
};

bool isSlot(const Napi::Value &value);
WriteTarget writeTarget(const Napi::Value &value);
void exportShmNamespace(Napi::Env env, Napi::Object &exports);

} // namespace ShmRing
