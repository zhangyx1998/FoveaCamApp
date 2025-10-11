// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <Protocol/Packet.h>
#include <Protocol/Version.h>
#include <core_pins.h>

#include "Board.h"
#include "Global.h"
#include "MEMS.h"
#include "convert.h"

static void send(Protocol::RawPacket &packet) {
  if (COBS::tx.encode(packet.finalize()))
    Serial.write(COBS::tx.data(), COBS::tx.size());
}

void Protocol::reject(const Sequence &seq, Property p,
                      const std::string &reason) {
  RawPacket packet{Method::REJ, p, seq};
  packet.setData(reason.data(), reason.size());
  send(packet);
}

#define HANDLE_GET(PACKET)                                                     \
  template <> void Packet::PACKET::Prototype::GET(const Protocol::Sequence &seq)

#define HANDLE_SET(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::SET(const Protocol::Sequence &seq,           \
                                      Inflated payload)

#define HANDLE_ACK(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::ACK(const Protocol::Sequence &seq,           \
                                      Inflated payload)

#define HANDLE_SYN(PACKET)                                                     \
  template <>                                                                  \
  void Packet::PACKET::Prototype::SYN(const Protocol::Sequence &seq,           \
                                      Inflated payload)

HANDLE_GET(System::Info) {
  auto packet = Create::ACK(seq);
  deflate(SYSTEM_INFO, packet);
  send(packet);
}

HANDLE_GET(System::Version) {
  auto packet = Create::ACK(seq);
  deflate({.major = Protocol::Version::Major,
           .minor = Protocol::Version::Minor,
           .patch = Protocol::Version::Patch},
          packet);
  send(packet);
}

HANDLE_SET(System::Reset) {
  auto packet = Create::ACK(seq);
  if (payload.type == Payload::HARD) {
    VERB("Hard reset requested");
    send(packet);
    delay(100);
    _reboot_Teensyduino_();
    crash("Reboot failed");
  }
  if (payload.type == Payload::SOFT) {
    VERB("Soft reset requested");
    send(packet);
    delay(100);
    asm volatile("bkpt"); // Breakpoint instruction causes reset
    crash("Reboot failed");
  }
  reject(seq, "Unknown reset type");
}

HANDLE_GET(System::Enable) {
  auto packet = Create::ACK(seq);
  deflate({.enable = Global::system_enabled}, packet);
  send(packet);
}

HANDLE_SET(System::Enable) {
  if (payload.enable && !Global::system_enabled) {
    // Enable system
    VERB("Enabling system");
    Board::enable.write(Board::ENABLE);
    delay(1);
    MEMS::enable();
    Board::low_pass_filter.tone();
    Global::system_enabled = true;
    Global::time.reset(0);
  } else if (!payload.enable && Global::system_enabled) {
    // Disable system
    VERB("Disabling system");
    MEMS::disable();
    delay(1);
    Board::enable.write(Board::DISABLE);
    Board::low_pass_filter.noTone();
    Global::system_enabled = false;
  } else {
    VERB("System enable state unchanged");
  }
  GET(seq);
}

HANDLE_GET(Config::Log) {
  auto packet = Create::ACK(seq);
  deflate({.level = Global::log_level}, packet);
  send(packet);
}

HANDLE_SET(Config::Log) {
  Global::log_level = payload.level;
  VERB("Log level set to %u (%s)", Global::log_level,
       convert<std::string>(Global::log_level).c_str());
  GET(seq);
}

HANDLE_GET(Config::LPF) {
  auto packet = Create::ACK(seq);
  deflate({.frequency = Global::lpf_frequency}, packet);
  send(packet);
}

HANDLE_SET(Config::LPF) {
  VERB("Setting LPF frequency to %u Hz", payload.frequency);
  Global::lpf_frequency = payload.frequency;
  Board::low_pass_filter.freq(Global::lpf_frequency);
  GET(seq);
}

HANDLE_GET(Config::Bias) {
  auto packet = Create::ACK(seq);
  deflate({.voltage = Global::bias_voltage}, packet);
  send(packet);
}

HANDLE_SET(Config::Bias) {
  if (Global::system_enabled) {
    reject(seq, "Cannot set bias while system is enabled");
    return;
  }
  VERB("Setting bias voltage to %u (%.2f volts)", payload.voltage,
       (200.0f * payload.voltage) / 65535.0f);
  Global::bias_voltage = payload.voltage;
  GET(seq);
}

HANDLE_SET(Command::Actuate) {
  if (!Global::system_enabled) {
    reject(seq, "Cannot perform action: system is not enabled");
    return;
  }
  auto res = payload;
  MEMS::set(MEMS::Device::LEFT, payload.left);
  MEMS::set(MEMS::Device::RIGHT, payload.right);
  MEMS::apply();
  delayMicroseconds(payload.settle_time);
  res.complete_time = Global::time.now();
  auto packet = Create::ACK(seq);
  deflate(res, packet);
  send(packet);
}

HANDLE_SET(Command::Trigger) {
  auto res = payload;
  for (auto &cam : Board::camera)
    cam.output.write(HIGH);
  delayMicroseconds(payload.duration);
  for (auto &cam : Board::camera)
    cam.output.write(LOW);
  res.timestamp = Global::time.now();
  auto packet = Create::ACK(seq);
  deflate(res, packet);
  send(packet);
}
