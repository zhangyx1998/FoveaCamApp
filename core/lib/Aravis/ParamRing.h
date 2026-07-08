// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// unified-time-and-topology §3/§5 (B, native re-plumb): the native mirror/H
// ring — a fixed-capacity history of time-stamped parameter vectors (v1: a
// 3×3 homography as 9 doubles, row-major). The JS actuation loop WRITES at up
// to ~1 kHz via the `pushHomography` NAPI; the undistort thread READS by the
// frame's host-ns time: the nearest entry ≤ hostNs, linearly interpolated
// toward the next entry when the query falls between two samples (linear
// interp of H entries is the accepted v1 — the step between 1 kHz samples is
// tiny; renormalization is the caller's follow-up if ever needed).
//
// Concurrency: ONE writer (the NAPI/JS thread) + ONE reader (the undistort
// thread), guarded by a plain mutex — at 1 kHz writes / camera-rate reads the
// critical sections are tens of ns; a seqlock buys nothing here.
//
// Entries are assumed pushed in non-decreasing hostNs order (the writer is a
// single sequential loop). An out-of-order push is accepted but clamps to the
// previous timestamp (monotonicity preserved; TODO(B-r2): surface a counter
// if out-of-order pushes ever become a real signal).

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace Arv {

class ParamRing {
public:
  static constexpr size_t VALUES = 9; // 3×3 homography, row-major
  using Params = std::array<double, VALUES>;
  struct Entry {
    int64_t hostNs = 0;
    Params v{};
  };

  explicit ParamRing(size_t capacity = 4096)
      : buf_(std::max<size_t>(capacity, 2)) {}

  // Writer (JS/NAPI thread).
  void push(int64_t hostNs, const double *v) {
    std::scoped_lock lock(m_);
    Entry &e = buf_[(head_ + count_) % buf_.size()];
    if (count_ == buf_.size())
      head_ = (head_ + 1) % buf_.size(); // overwrite the oldest
    else
      ++count_;
    // Monotonicity clamp (see header note).
    const int64_t prev = count_ > 1 ? at(count_ - 2).hostNs : hostNs;
    e.hostNs = std::max(hostNs, prev);
    std::copy(v, v + VALUES, e.v.begin());
  }

  // Reader (undistort thread). Nearest-or-interpolated entry for `hostNs`:
  //   - empty ring            -> false (caller passes the frame through);
  //   - hostNs ≥ newest       -> newest (nearest ≤);
  //   - hostNs ≤ oldest       -> oldest (clamped — predictable startup);
  //   - between two samples   -> linear interpolation of the 9 entries.
  bool lookup(int64_t hostNs, Params &out) const {
    std::scoped_lock lock(m_);
    if (count_ == 0)
      return false;
    // Scan back from the newest — frame times trail the write head closely.
    size_t hi = count_ - 1;
    if (hostNs >= at(hi).hostNs) {
      out = at(hi).v;
      return true;
    }
    while (hi > 0 && at(hi - 1).hostNs > hostNs)
      --hi;
    if (hi == 0) { // before the oldest sample
      out = at(0).v;
      return true;
    }
    const Entry &a = at(hi - 1); // a.hostNs ≤ hostNs < b.hostNs
    const Entry &b = at(hi);
    const double span = static_cast<double>(b.hostNs - a.hostNs);
    const double t =
        span > 0 ? static_cast<double>(hostNs - a.hostNs) / span : 0.0;
    for (size_t i = 0; i < VALUES; ++i)
      out[i] = a.v[i] + (b.v[i] - a.v[i]) * t;
    return true;
  }

  size_t size() const {
    std::scoped_lock lock(m_);
    return count_;
  }

  void clear() {
    std::scoped_lock lock(m_);
    head_ = count_ = 0;
  }

private:
  const Entry &at(size_t i) const { return buf_[(head_ + i) % buf_.size()]; }
  Entry &at(size_t i) { return buf_[(head_ + i) % buf_.size()]; }

  mutable std::mutex m_;
  std::vector<Entry> buf_;
  size_t head_ = 0;  // index of the oldest entry
  size_t count_ = 0; // live entries (≤ capacity)
};

} // namespace Arv
