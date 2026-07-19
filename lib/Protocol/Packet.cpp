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

template <> std::string convert(const Packet::System::Reset::Type &type) {
  switch (type) {
  case Packet::System::Reset::Type::SOFT:
    return "SOFT";
  case Packet::System::Reset::Type::HARD:
    return "HARD";
  case Packet::System::Reset::Type::MEMS:
    return "MEMS";
  default:
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
    throw std::invalid_argument("Unknown Packet::System::Reset::Type: " +
                                std::to_string(static_cast<uint8_t>(type)));
#else
    return "SOFT";
#endif
  }
}

template <> Packet::System::Reset::Type convert(const std::string &type) {
  if (type == "SOFT")
    return Packet::System::Reset::Type::SOFT;
  if (type == "HARD")
    return Packet::System::Reset::Type::HARD;
  if (type == "MEMS")
    return Packet::System::Reset::Type::MEMS;
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown reset type: " + type);
#else
  return Packet::System::Reset::Type::SOFT;
#endif
}

template <> std::string convert(const Packet::Command::MirrorStream::Op &op) {
  switch (op) {
  case Packet::Command::MirrorStream::Op::CREATE:
    return "CREATE";
  case Packet::Command::MirrorStream::Op::UPDATE:
    return "UPDATE";
  case Packet::Command::MirrorStream::Op::TERMINATE:
    return "TERMINATE";
  default:
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
    throw std::invalid_argument("Unknown Packet::Command::MirrorStream::Op: " +
                                std::to_string(static_cast<uint8_t>(op)));
#else
    return "CREATE";
#endif
  }
}

template <> Packet::Command::MirrorStream::Op convert(const std::string &op) {
  if (op == "CREATE")
    return Packet::Command::MirrorStream::Op::CREATE;
  if (op == "UPDATE")
    return Packet::Command::MirrorStream::Op::UPDATE;
  if (op == "TERMINATE")
    return Packet::Command::MirrorStream::Op::TERMINATE;
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown Packet::Command::MirrorStream::Op: " + op);
#else
  return Packet::Command::MirrorStream::Op::CREATE;
#endif
}
