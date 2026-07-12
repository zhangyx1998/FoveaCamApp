// =============================================================================
// Header file for mems operations
// =============================================================================
// License: MIT
// Author: Yuxuan Zhang (zhangyuxuan@ufl.edu)
// =============================================================================void
#ifndef MEMS_DRV_H
#define MEMS_DRV_H

#include <Arduino.h>
#include <cstdint>

#include <Protocol/Packet.h>

namespace MEMS {

typedef enum Device : uint8_t {
  NONE = 0b00,
  LEFT = 0b01,
  RIGHT = 0b10,
  ALL = 0b11,
} Device;

using Packet::Command::MirrorPosition;

void enable();
// M1 periodic config re-assertion (docs/dev/right-dac-freeze-2026-07-12.md):
// re-send the idempotent DAC-power / internal-reference / software-LDAC setup
// words to BOTH mirrors. Never RESETs, never writes a value — the mirror does
// not move, so it is safe to call mid-capture.
void refresh();
void disable();
void set(Device device, const MirrorPosition &pos);
void apply();

} // namespace MEMS

#endif
