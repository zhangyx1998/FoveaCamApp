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

const SPISettings SPI::settings{// 20MHz / 2 = 10MHz
                                20000000,
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
