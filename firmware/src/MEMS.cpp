#include <Arduino.h>
#include <SPI.h>
#include <core_pins.h>
#include <cstdint>
#include <stdint.h>

#include "Board.h"
#include "Global.h"
#include "MEMS-SPI.h"
#include "MEMS.h"

namespace MEMS {

// M3 (docs/dev/right-dac-freeze-2026-07-12.md): the requested SPI clock, dropped
// from 20 MHz to 2 MHz to cut marginal SCLK edges at the far (right-driver) end
// of the shared bus — a suspected source of the corrupted-word DAC freeze. The
// AD5664R sees this after the Teensy's SPI divider; the actual on-wire clock is
// bench-verified (RIG-GATED). Build-time constant for now; a runtime knob may
// follow (see M3 in the diagnosis doc).
static constexpr uint32_t SPI_CLOCK_HZ = 2000000; // 2 MHz requested
const SPISettings SPI::settings{SPI_CLOCK_HZ,
                                // MSB first
                                MSBFIRST,
                                // SPI_MODE2: CPOL=1, CPHA=0
                                SPI_MODE2};

static bool selected[2] = {false, false};
inline void select(uint8_t d) {
  if ((d & Device::LEFT) != 0 && !selected[0]) {
    VERB("MEMS Select LEFT");
    selected[0] = true;
    Board::mems_cs[0].write(Board::SELECT);
  } else if ((d & Device::LEFT) == 0 && selected[0]) {
    VERB("MEMS Unselect LEFT");
    selected[0] = false;
    Board::mems_cs[0].write(Board::UNSELECT);
  }
  if ((d & Device::RIGHT) != 0 && !selected[1]) {
    VERB("MEMS Select RIGHT");
    selected[1] = true;
    Board::mems_cs[1].write(Board::SELECT);
  } else if ((d & Device::RIGHT) == 0 && selected[1]) {
    VERB("MEMS Unselect RIGHT");
    selected[1] = false;
    Board::mems_cs[1].write(Board::UNSELECT);
  }
  // AD5664R Requires 5ns CS setup time. Giving 20ns here.
  delayNanoseconds(20);
}

static inline void send(uint8_t device, SPI::Word &&word) {
  select(device);
  word.send();
  select(Device::NONE);
  ::SPI.transfer(0b00000000); // Delay at least 8 SPI clock cycles
}

void enable() {
  INFO("MEMS Enable");
  // 0x280001 FULL RESET
  send(Device::ALL, {SPI::CMD::RESET, SPI::CH::NONE, 1});
  // 0x380001 ENABLE INTERNAL REFERENCE
  send(Device::ALL, {SPI::CMD::INT_REF_SETUP, SPI::CH::NONE, 1});
  // 0x20000F ENABLE ALL DAC Channels
  send(Device::ALL, {SPI::CMD::DAC_POWER, SPI::CH::NONE, 0b1111});
  // 0x300000 ENABLE SOFTWARE LDAC
  send(Device::ALL, {SPI::CMD::LDAC_SETUP, SPI::CH::NONE, 0});
  // Set V_BIAS to Neutral
  send(Device::ALL,
       {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::ALL, Global::bias_voltage});
};

void refresh() {
  // M1 periodic config re-assertion (docs/dev/right-dac-freeze-2026-07-12.md):
  // re-send ONLY the idempotent setup words a glitched SPI frame could have
  // silently cleared — all DAC channels powered, internal reference on, software
  // LDAC. Deliberately NO RESET (0x280001 zeroes every output → the mirror would
  // jump) and NO value/bias write, so refresh NEVER moves the mirror and is safe
  // mid-capture. Broadcast to both mirrors (Device::ALL).
  // 0x20000F ENABLE ALL DAC Channels
  send(Device::ALL, {SPI::CMD::DAC_POWER, SPI::CH::NONE, 0b1111});
  // 0x380001 ENABLE INTERNAL REFERENCE
  send(Device::ALL, {SPI::CMD::INT_REF_SETUP, SPI::CH::NONE, 1});
  // 0x300000 ENABLE SOFTWARE LDAC
  send(Device::ALL, {SPI::CMD::LDAC_SETUP, SPI::CH::NONE, 0});
};

void disable() {
  INFO("MEMS Disable");
  select(Device::ALL);
  // Set V_BIAS to Neutral
  send(Device::ALL,
       {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::ALL, Global::bias_voltage});
}

void set(Device device, const MirrorPosition &pos) {
  send(device, {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::A, pos.ch[0]});
  send(device, {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::B, pos.ch[1]});
  send(device, {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::D, pos.ch[2]});
  send(device, {SPI::CMD::WRITE_UPDATE_DAC, SPI::CH::C, pos.ch[3]});
}

void apply() { send(Device::ALL, {SPI::CMD::UPDATE_DAC, SPI::CH::ALL, 0}); }

} // namespace MEMS
