// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include "Global.h"
#include "MEMS.h"
#include "Streams.h"

namespace Streams {

namespace {

struct Entry {
  bool active = false; // CREATEd, not yet TERMINATEd
  bool pendingFrame = false;
  MirrorPosition left{};
  MirrorPosition right{};
};

Entry table[CAPACITY];
uint8_t activeId = INVALID_ID;
bool dirty = false; // active stream's target not yet written to the DAC

// Housekeeping cadence for periodic config re-assertion.
constexpr uint64_t REFRESH_PERIOD_US = 1'000'000; // ~1 Hz
uint64_t lastRefreshUs = 0;
bool refreshPrimed = false; // cadence clock started on the enable edge

} // namespace

bool exists(uint8_t id) { return id < CAPACITY && table[id].active; }

bool hasPendingFrame(uint8_t id) {
  return exists(id) && table[id].pendingFrame;
}

void setPendingFrame(uint8_t id, bool pending) {
  if (exists(id))
    table[id].pendingFrame = pending;
}

bool create(uint8_t id, const MirrorPosition &left,
            const MirrorPosition &right) {
  if (id >= CAPACITY || table[id].active)
    return false;
  table[id] = Entry{true, false, left, right};
  // A stream drives the DAC only while ACTIVE. A freshly CREATEd stream takes
  // the DAC when nothing else holds it; captures still re-activate their own
  // stream per request. Hosts run one exclusive stream, so this never steals
  // from a live one.
  if (activeId == INVALID_ID) {
    activeId = id;
    dirty = true;
  }
  return true;
}

bool update(uint8_t id, const MirrorPosition &left,
            const MirrorPosition &right) {
  if (!exists(id))
    return false;
  // Guard against the strobe ISR's Streams::snapshot() (Capture.cpp) reading
  // a torn MirrorPosition mid-write — it runs concurrently with this from
  // interrupt context.
  noInterrupts();
  table[id].left = left;
  table[id].right = right;
  interrupts();
  if (id == activeId)
    dirty = true;
  return true;
}

bool terminate(uint8_t id) {
  if (!exists(id) || table[id].pendingFrame)
    return false;
  table[id] = Entry{};
  if (id == activeId)
    activeId = INVALID_ID;
  return true;
}

bool activate(uint8_t id) {
  if (!exists(id))
    return false;
  activeId = id;
  dirty = true;
  return true;
}

uint8_t active() { return activeId; }

void snapshot(MirrorPosition &left, MirrorPosition &right) {
  if (activeId == INVALID_ID) {
    left = MirrorPosition{};
    right = MirrorPosition{};
    return;
  }
  left = table[activeId].left;
  right = table[activeId].right;
}

void touch() {
  // Force the active stream's target to be re-committed on the next tick(),
  // even if it hasn't changed. Used after a MEMS re-init (Protocol.cpp MEMS
  // recovery) or a periodic refresh so the DAC is re-loaded with live targets.
  if (activeId != INVALID_ID)
    dirty = true;
}

void housekeeping() {
  // Periodic config re-assertion. Called every loop() but acts only while the
  // system is enabled and >= 1 s
  // since the last refresh. MEMS::refresh() re-sends config-only words (no
  // RESET, no value write), so the mirror never moves — safe mid-capture; the
  // subsequent touch() re-commits the current targets within one tick.
  if (!Global::system_enabled) {
    refreshPrimed = false;
    return;
  }
  const uint64_t now = Global::time.now();
  if (!refreshPrimed) {
    // Enable just ran the full MEMS::enable() (these words included) — start the
    // 1 Hz clock here so the first re-assertion lands ~1 s later.
    refreshPrimed = true;
    lastRefreshUs = now;
    return;
  }
  if (now - lastRefreshUs < REFRESH_PERIOD_US)
    return;
  lastRefreshUs = now;
  MEMS::refresh();
  touch();
}

void tick() {
  if (activeId == INVALID_ID || !dirty)
    return;
  MEMS::set(MEMS::Device::LEFT, table[activeId].left);
  MEMS::set(MEMS::Device::RIGHT, table[activeId].right);
  MEMS::apply();
  dirty = false;
}

void clear() {
  for (auto &entry : table)
    entry = Entry{};
  activeId = INVALID_ID;
  dirty = false;
}

} // namespace Streams
