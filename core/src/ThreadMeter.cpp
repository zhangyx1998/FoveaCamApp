// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native free-thread instrumentation meter (see ThreadMeter.h). System-library-
// only. The bin-ring math is the C++ port of C-18's `metering.ts`; the seqlock
// is the same even/odd + retry discipline as the SHM ring.

#include "ThreadMeter.h"

#include <algorithm>

namespace Meter {

// ---- bin-ring (C-18 port) --------------------------------------------------

void ThreadMeter::rotate(Ring &r, int64_t now) {
  const int64_t steps = (now - r.binStart) / BIN_MS;
  if (steps <= 0)
    return;
  const uint32_t clears =
      steps < static_cast<int64_t>(BIN_COUNT) ? static_cast<uint32_t>(steps)
                                              : BIN_COUNT;
  for (uint32_t i = 0; i < clears; ++i) {
    r.cursor = (r.cursor + 1) % BIN_COUNT;
    r.bins[r.cursor] = 0;
  }
  r.binStart += steps * BIN_MS;
}

void ThreadMeter::recordEvent(Ring &r, int64_t now) {
  rotate(r, now);
  if (r.lastEventTs >= 0) {
    const double interval = static_cast<double>(now - r.lastEventTs);
    if (interval > r.bins[r.cursor])
      r.bins[r.cursor] = interval;
  }
  r.lastEventTs = now;
  r.count++;
}

double ThreadMeter::ringMax(Ring r, int64_t now) {
  rotate(r, now); // r is a by-value copy — safe to mutate on the probe side
  double m = 0;
  for (const double b : r.bins)
    if (b > m)
      m = b;
  const double inProgress =
      r.lastEventTs >= 0 ? static_cast<double>(now - r.lastEventTs) : 0.0;
  return std::max(m, inProgress);
}

StreamStat ThreadMeter::streamStat(const Ring &r, int64_t now,
                                   int64_t uptimeMs) {
  StreamStat s;
  s.count = r.count;
  s.ratePerSec = r.count / (static_cast<double>(uptimeMs) / 1000.0);
  s.maxIntervalMs = ringMax(r, now);
  return s;
}

// ---- construction ----------------------------------------------------------

ThreadMeter::ThreadMeter(std::string name, std::vector<std::string> inputs,
                         std::vector<std::string> outputs, int64_t nowMs)
    : name_(std::move(name)), inputNames_(std::move(inputs)),
      outputNames_(std::move(outputs)), createdAtMs_(nowMs) {
  for (Ring &r : block_.inputs)
    r.binStart = nowMs;
  for (Ring &r : block_.outputs)
    r.binStart = nowMs;
}

int32_t ThreadMeter::indexOf(const std::vector<std::string> &names,
                             const std::string &s) const {
  for (size_t i = 0; i < names.size() && i < MAX_STREAMS; ++i)
    if (names[i] == s)
      return static_cast<int32_t>(i);
  return -1;
}

// ---- writer side (single owning thread) — seqlock even/odd version ---------

void ThreadMeter::ingest(const std::string &stream, int64_t nowMs) {
  const int32_t i = indexOf(inputNames_, stream);
  if (i < 0)
    return;
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release); // odd
  recordEvent(block_.inputs[i], nowMs);
  version_.store(v + 2, std::memory_order_release); // even
}

void ThreadMeter::emit(const std::string &stream, int64_t nowMs) {
  const int32_t i = indexOf(outputNames_, stream);
  if (i < 0)
    return;
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release);
  recordEvent(block_.outputs[i], nowMs);
  version_.store(v + 2, std::memory_order_release);
}

void ThreadMeter::begin(int64_t nowMs) {
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release);
  if (block_.openSpanAt < 0)
    block_.openSpanAt = nowMs;
  version_.store(v + 2, std::memory_order_release);
}

void ThreadMeter::end(int64_t nowMs) {
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release);
  if (block_.openSpanAt >= 0) {
    block_.busyMs += std::max<int64_t>(0, nowMs - block_.openSpanAt);
    block_.openSpanAt = -1;
  }
  version_.store(v + 2, std::memory_order_release);
}

void ThreadMeter::addBusy(double ms) {
  if (ms <= 0)
    return;
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release);
  block_.busyMs += ms;
  version_.store(v + 2, std::memory_order_release);
}

void ThreadMeter::drop(uint64_t n) {
  const uint64_t v = version_.load(std::memory_order_relaxed);
  version_.store(v + 1, std::memory_order_release);
  block_.dropTotal += n;
  version_.store(v + 2, std::memory_order_release);
}

// ---- probe side (any thread) — seqlock read of a consistent copy -----------

Snapshot ThreadMeter::probe(int64_t nowMs) const {
  Block copy;
  for (uint32_t tries = 0;; ++tries) {
    const uint64_t v1 = version_.load(std::memory_order_acquire);
    if ((v1 & 1) == 0) {
      copy = block_; // seqlock copy of the POD block
      std::atomic_thread_fence(std::memory_order_acquire);
      const uint64_t v2 = version_.load(std::memory_order_acquire);
      if (v1 == v2)
        break;
    }
    if (tries >= MAX_RETRIES) {
      copy = block_; // best-effort: a hot writer never blocks the probe
      break;
    }
  }

  Snapshot s;
  s.name = name_;
  s.startedAtMs = createdAtMs_;
  s.snapshotAtMs = nowMs;
  s.uptimeMs = std::max<int64_t>(1, nowMs - createdAtMs_);
  const double busy =
      copy.busyMs +
      (copy.openSpanAt >= 0 ? static_cast<double>(std::max<int64_t>(
                                  0, nowMs - copy.openSpanAt))
                            : 0.0);
  s.busyMs = busy;
  s.utilization = std::min(1.0, busy / static_cast<double>(s.uptimeMs));
  for (size_t i = 0; i < inputNames_.size() && i < MAX_STREAMS; ++i)
    s.inputs.push_back({inputNames_[i], streamStat(copy.inputs[i], nowMs, s.uptimeMs)});
  for (size_t i = 0; i < outputNames_.size() && i < MAX_STREAMS; ++i)
    s.outputs.push_back({outputNames_[i], streamStat(copy.outputs[i], nowMs, s.uptimeMs)});
  s.dropTotal = copy.dropTotal;
  return s;
}

} // namespace Meter
