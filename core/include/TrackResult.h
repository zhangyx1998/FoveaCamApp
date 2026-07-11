// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// One tracker result off a tracker brick's thread (WS1 1d) — EXTRACTED from
// Tracker.cpp (native-port-pipe.md wave): the payload now flows across TUs on
// a native port link (`kcf.track_out → imm.measure_in`), so the struct must be
// visible to both the tracker and the IMM predictor brick. The NAPI `convert`
// specializations stay in Tracker.cpp (only that TU crosses to JS with it).

#include <opencv2/core.hpp>
#include <pointer.h>

struct TrackResult : Shared<TrackResult> {
  bool found = false;
  cv::Rect bbox;
  // Bbox center (computed once in native — the value every consumer wants).
  // For an OVERRIDDEN result this is the override point (bbox may be a centered
  // box of the last armed size, or empty if never armed). Valid iff `found`.
  cv::Point2d center{0, 0};
  // True while the tracker is under a JS override (drag): KCF is NOT updated;
  // `center` is the override value. Flows downstream (matcher → PID) so each
  // stage acts correspondingly (controller-node-and-fifo-edges §3.5).
  bool overridden = false;
  uint64_t seq = 0;             // result counter (transform thread)
  uint64_t deviceTimestamp = 0; // source frame's camera-clock stamp (correlation)
};
