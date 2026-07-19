// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// Bounded DROP-OLDEST channel (native-port-pipe.md link type "ring"): the
// StereoStream PairRecord ring generalized into a reusable Threading channel.
// Producer `write()` NEVER blocks — when the ring is full the OLDEST queued
// item is shed (counted in `drops`), so an overloaded consumer degrades its
// own view without ever backpressuring the producer. Consumer `read()` blocks
// until an item or close; returns false once closed AND drained (a close still
// lets the reader flush what's queued — the RecordChannel contract).
//
// Sits between `Leaky` (capacity 1, latest-wins) and `FIFO` (lossless,
// blocking backpressure): bounded history, lossy at the tail. All counters are
// plain atomics probed out-of-loop (the never-gate rule).

#include "exception.h"
#include <pointer.h>

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>

namespace Threading {

template <typename T> class Ring : public Shared<Ring<T>> {
public:
  explicit Ring(size_t capacity) : cap_(capacity ? capacity : 1) {}
  ~Ring() { close(); }

  /** Producer side — NON-BLOCKING. Full → shed the OLDEST (metered). A write
   *  after close is silently ignored (the producer is being torn down). */
  void write(const T &item) {
    {
      std::scoped_lock lk(m_);
      if (closed_)
        return;
      q_.push_back(item);
      while (q_.size() > cap_) {
        q_.pop_front();
        drops_.fetch_add(1, std::memory_order_relaxed);
      }
      // Post-trim occupancy: the momentary cap+1 before the shed is an
      // artifact, not a depth the consumer could ever observe.
      if (q_.size() > high_water_)
        high_water_ = q_.size();
    }
    cv_.notify_one();
  }
  void write(T &&item) {
    {
      std::scoped_lock lk(m_);
      if (closed_)
        return;
      q_.push_back(std::move(item));
      while (q_.size() > cap_) {
        q_.pop_front();
        drops_.fetch_add(1, std::memory_order_relaxed);
      }
      // Post-trim occupancy: the momentary cap+1 before the shed is an
      // artifact, not a depth the consumer could ever observe.
      if (q_.size() > high_water_)
        high_water_ = q_.size();
    }
    cv_.notify_one();
  }

  /** Consumer side — blocks until an item or close. False = closed + drained
   *  (a close still lets the reader flush the queue first). */
  bool read(T &out) {
    std::unique_lock lk(m_);
    cv_.wait(lk, [&] { return closed_ || !q_.empty(); });
    if (q_.empty())
      return false; // closed + drained
    out = std::move(q_.front());
    q_.pop_front();
    return true;
  }

  void close() {
    {
      std::scoped_lock lk(m_);
      closed_ = true;
    }
    cv_.notify_all();
  }

  size_t capacity() const { return cap_; }
  uint64_t drops() const { return drops_.load(std::memory_order_relaxed); }
  size_t high_water() {
    std::scoped_lock lk(m_);
    return high_water_;
  }
  size_t queued_size() {
    std::scoped_lock lk(m_);
    return q_.size();
  }

private:
  std::mutex m_;
  std::condition_variable cv_;
  std::deque<T> q_;
  const size_t cap_;
  size_t high_water_ = 0;
  bool closed_ = false;
  std::atomic<uint64_t> drops_{0};
};

} // namespace Threading
