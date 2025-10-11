// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include "Protocol.h"

namespace Packet {

inline Protocol::RawPacket
reject(const std::string &reason,
       Protocol::Property p = Protocol::Property::NONE, uint16_t seq = 0) {
  Protocol::RawPacket packet(Protocol::REJ, p, seq);
  packet.setData(reason.c_str(), reason.size());
  return packet;
}

namespace Log {

typedef Protocol::StringPacket<Protocol::Property::LOG> Log;

inline Protocol::RawPacket create(std::string message) {
  auto packet = Log::Prototype::Create::SYN(0);
  Log::Prototype::deflate(message, packet);
  return packet;
}

} // namespace Log

namespace System {

typedef Protocol::StringPacket<Protocol::Property::SYS_INFO> Info;

FIXED_SIZE_PACKET(Version, SYS_VERSION) {
  uint8_t major;
  uint8_t minor;
  uint8_t patch;
};

FIXED_SIZE_PACKET(Reset, SYS_RESET) {
  typedef enum Type : uint8_t { SOFT = 0, HARD = 1 } Type;
  Type type;
};

FIXED_SIZE_PACKET(Enable, SYS_ENABLE) { uint8_t enable; };

} // namespace System

namespace Config {

FIXED_SIZE_PACKET(Log, CFG_LOG) {
  typedef enum Level : uint8_t {
    OFF = 0,
    ERR = 1,
    WARN = 2,
    INFO = 3,
    VERB = 4,
  } Level;
  Level level;
};

FIXED_SIZE_PACKET(LPF, CFG_LPF) {
  // Low Pass Filter cutoff frequency in Hz
  uint16_t frequency;
};

FIXED_SIZE_PACKET(Bias, CFG_BIAS) {
  // Bias voltage in 16-bit unsigned integer
  uint16_t voltage;
};

} // namespace Config

namespace Command {

PACKED(MirrorPosition) { uint16_t ch[4]; };

typedef uint32_t Microseconds;

FIXED_SIZE_PACKET(Actuate, CMD_ACTUATE) {
  MirrorPosition left;
  MirrorPosition right;
  union {
    Microseconds settle_time;   // Time to wait after mirror movement
    Microseconds complete_time; // Timestamp when action is complete
  };
};

FIXED_SIZE_PACKET(Trigger, CMD_TRIGGER) {
  union {
    Microseconds duration;  // Duration to trigger
    Microseconds timestamp; // Timestamp when trigger starts
  };
};

static_assert(sizeof(Trigger) == sizeof(Microseconds));

} // namespace Command

} // namespace Packet
