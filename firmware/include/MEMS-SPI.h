// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once
#include "Global.h"
#include <SPI.h>
#include <cstdint>

namespace MEMS {

namespace SPI {

extern const SPISettings settings;

namespace CMD {

typedef enum CMD : uint8_t {
  // Write to Input Register N
  WRITE_IREG = 0b000,
  // Update DAC Register N
  UPDATE_DAC = 0b001,
  // Write to Input Register N, Update All (software LDAC)
  APPLY_IREG = 0b010,
  // Write and Update DAC Register N
  WRITE_UPDATE_DAC = 0b011,
  // DAC Power Control (specified by 0~4 bits in the value field)
  DAC_POWER = 0b100,
  // Reset
  RESET = 0b101,
  // LDAC Register Setup
  LDAC_SETUP = 0b110,
  // Internal Reference Setup (on/off)
  INT_REF_SETUP = 0b111,
} CMD;

}; // namespace CMD

namespace CH {

typedef enum CH : uint8_t {
  NONE = 0b000, // Used when DAC field is ignored
  A = 0b000,
  B = 0b001,
  C = 0b010,
  D = 0b011,
  ALL = 0b111,
} CH;

static constexpr CH ch[] = {CH::A, CH::B, CH::D, CH::C};

}; // namespace CH

static constexpr uint8_t head(CMD::CMD cmd, CH::CH ch) {
  return (static_cast<uint8_t>(cmd) << 3) | (static_cast<uint8_t>(ch));
}

// Driver board accepts 3 Byte SPI word:
// Header (1 Byte) | Value (2 Bytes, Big Endian)
// Last (4th) byte of Word is unused
typedef struct Word {
  uint8_t header;
  uint8_t value[2];
  const uint8_t unused = 0b00000000;
  constexpr Word(uint8_t header, uint8_t high, uint8_t low)
      : header(header), value{high, low} {}
  constexpr Word(CMD::CMD cmd, CH::CH ch, uint16_t value = 0)
      : Word(head(cmd, ch), (value >> 8) & 0xFF, value & 0xFF) {}
  uint16_t getValue() const { return (value[0] << 8) | value[1]; }
  void setValue(uint16_t v) {
    value[0] = (v >> 8) & 0xFF;
    value[1] = v & 0xFF;
  }
  inline void send() const {
    ::SPI.beginTransaction(settings);
    ::SPI.transfer(header);
    ::SPI.transfer(value[0]);
    ::SPI.transfer(value[1]);
    ::SPI.endTransaction();
    VERB("SPI::send(%02X %02X %02X)", header, value[0], value[1]);
  }
} Word;

} // namespace SPI

} // namespace MEMS
