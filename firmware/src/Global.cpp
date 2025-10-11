// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Protocol/Packet.h>

#include "Board.h"
#include "Global.h"

namespace COBS {

RX rx;
TX tx;

} // namespace COBS

namespace Global {

Time<micros> time;

bool system_enabled = false;

using Packet::Config::Log;
Log::Level log_level = Log::INFO;

uint16_t lpf_frequency = 0;

uint16_t bias_voltage = 0;

} // namespace Global

char log_buffer[COBS::MaxPacketSize];

void crash(std::string err) {
  while (true) {
    Serial.println(err.c_str());
    for (unsigned i = 0; i < 5; i++) {
      delay(100);
      Board::led.write(Board::LED_ON);
      delay(100);
      Board::led.write(Board::LED_OFF);
    }
  }
}
