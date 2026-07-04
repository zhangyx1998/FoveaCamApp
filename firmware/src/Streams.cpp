// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

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
  return true;
}

bool update(uint8_t id, const MirrorPosition &left,
            const MirrorPosition &right) {
  if (!exists(id))
    return false;
  // Guard against the strobe ISR's Streams::snapshot() (Capture.cpp) reading
  // a torn MirrorPosition mid-write — it runs concurrently with this from
  // interrupt context (§9 FW6).
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
