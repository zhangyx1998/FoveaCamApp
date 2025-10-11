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
void disable();
void set(Device device, const MirrorPosition &pos);
void apply();

} // namespace MEMS

#endif
