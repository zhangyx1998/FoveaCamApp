// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <convert.h>

#include "Packet.h"

template <> std::string convert(const Packet::Config::Log::Level &level) {
  switch (level) {
  case Packet::Config::Log::Level::OFF:
    return "OFF";
  case Packet::Config::Log::Level::ERR:
    return "ERR";
  case Packet::Config::Log::Level::WARN:
    return "WARN";
  case Packet::Config::Log::Level::INFO:
    return "INFO";
  case Packet::Config::Log::Level::VERB:
    return "VERB";
  default:
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
    throw std::invalid_argument("Unknown Packet::Config::Log::Level: " +
                                std::to_string(static_cast<uint8_t>(level)));
#else
    return "OFF";
#endif
  }
}

template <> Packet::Config::Log::Level convert(const std::string &level) {
  if (level == "OFF")
    return Packet::Config::Log::Level::OFF;
  if (level == "ERR")
    return Packet::Config::Log::Level::ERR;
  if (level == "WARN")
    return Packet::Config::Log::Level::WARN;
  if (level == "INFO")
    return Packet::Config::Log::Level::INFO;
  if (level == "VERB")
    return Packet::Config::Log::Level::VERB;
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown log level: " + level);
#else
  return Packet::Config::Log::Level::OFF;
#endif
}
