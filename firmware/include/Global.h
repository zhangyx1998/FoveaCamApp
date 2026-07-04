// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <Arduino.h>

#include <COBS/RX.h>
#include <COBS/TX.h>
#include <Protocol/Packet.h>
#include <crash.h>

#include <Time.h>

#define SYSTEM_INFO "FoveaCam Duo Controller"

namespace COBS {

extern RX rx;
extern TX tx;

} // namespace COBS

namespace Global {

extern Time<micros, uint64_t> time;

extern bool system_enabled;
extern Packet::Config::Log::Level log_level;
extern uint16_t lpf_frequency;
extern uint16_t bias_voltage;

} // namespace Global

extern char log_buffer[COBS::MaxPacketSize];
#define LOG(LV, TP, ...)                                                       \
  if (::Global::log_level >= ::Packet::Config::Log::Level::LV) {               \
    auto ret = snprintf(log_buffer, sizeof(log_buffer),                        \
                        "[" #LV "] " TP __VA_OPT__(, __VA_ARGS__));            \
    if (ret > 0) {                                                             \
      auto packet = ::Packet::Log::create(std::string(log_buffer, ret));       \
      if (COBS::tx.encode(packet.finalize())) {                                \
        Serial.write(::COBS::tx.data(), ::COBS::tx.size());                    \
      }                                                                        \
    }                                                                          \
  }

#define ERR(...) LOG(ERR, __VA_ARGS__)
#define WARN(...) LOG(WARN, __VA_ARGS__)
#define INFO(...) LOG(INFO, __VA_ARGS__)
#define VERB(...) LOG(VERB, __VA_ARGS__)
