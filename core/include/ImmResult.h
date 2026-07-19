// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// One prediction off the native IMM brick. The payload flows across TUs on a
// native port link (`imm.predict_out → compose.pred_in`); the NAPI `convert`
// specializations stay in ImmPredictor.cpp.

#include <cstdint>
#include <pointer.h>

struct ImmResult : Shared<ImmResult> {
  bool found = false;
  bool overridden = false;
  bool coasting = false; // emitted between measurements / on a predict-only miss
  bool hasCenter = false;
  double cx = 0, cy = 0;
  bool hasBbox = false;
  double bx = 0, by = 0, bw = 0, bh = 0;
  uint64_t seq = 0;
  uint64_t deviceTimestamp = 0;
  int64_t propagatedToNs = 0; // deviceTimestamp + Δ·1e9 (informational)
  // HOST steady-clock ns of the measurement INGEST this prediction is based
  // on: the compose brick's staleness gate compares this against its own
  // steady clock and skips feed-forward when the underlying measurement is too
  // old. 0 = unset; consumers treat that as stale.
  int64_t measuredAtNs = 0;
};
