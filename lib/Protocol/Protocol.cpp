// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <convert.h>

#include "Protocol.h"

template <> std::string convert(const Protocol::Method &method) {
  switch (method) {
  case Protocol::Method::NOP:
    return "NOP";
  case Protocol::Method::GET:
    return "GET";
  case Protocol::Method::SET:
    return "SET";
  case Protocol::Method::ACK:
    return "ACK";
  case Protocol::Method::REJ:
    return "REJ";
  case Protocol::Method::SYN:
    return "SYN";
  default:
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
    throw std::invalid_argument("Unknown Protocol::Method: " +
                                std::to_string(static_cast<uint8_t>(method)));
#else
    return "NOP";
#endif
  }
}

template <> Protocol::Method convert(const std::string &method) {
  if (method == "NOP")
    return Protocol::Method::NOP;
  if (method == "GET")
    return Protocol::Method::GET;
  if (method == "SET")
    return Protocol::Method::SET;
  if (method == "ACK")
    return Protocol::Method::ACK;
  if (method == "REJ")
    return Protocol::Method::REJ;
  if (method == "SYN")
    return Protocol::Method::SYN;
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown Protocol::Method: " + method);
#else
  return Protocol::Method::NOP;
#endif
}

template <> std::string convert(const Protocol::Property &property) {
  switch (property) {
  case Protocol::Property::NONE:
    return "NONE";
  case Protocol::Property::SYS_INFO:
    return "SYS_INFO";
  case Protocol::Property::SYS_VERSION:
    return "SYS_VERSION";
  case Protocol::Property::SYS_RESET:
    return "SYS_RESET";
  case Protocol::Property::SYS_ENABLE:
    return "SYS_ENABLE";
  case Protocol::Property::CFG_LOG:
    return "CFG_LOG";
  case Protocol::Property::CFG_LPF:
    return "CFG_LPF";
  case Protocol::Property::CFG_BIAS:
    return "CFG_BIAS";
  case Protocol::Property::CMD_ACTUATE:
    return "CMD_ACTUATE";
  case Protocol::Property::CMD_TRIGGER:
    return "CMD_TRIGGER";
  case Protocol::Property::LOG:
    return "LOG";
  default:
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
    throw std::invalid_argument("Unknown Protocol::Property: " +
                                std::to_string(static_cast<uint8_t>(property)));
#else
    return "NONE";
#endif
  }
}

template <> Protocol::Property convert(const std::string &property) {
  if (property == "NONE")
    return Protocol::Property::NONE;
  if (property == "SYS_INFO")
    return Protocol::Property::SYS_INFO;
  if (property == "SYS_VERSION")
    return Protocol::Property::SYS_VERSION;
  if (property == "SYS_RESET")
    return Protocol::Property::SYS_RESET;
  if (property == "SYS_ENABLE")
    return Protocol::Property::SYS_ENABLE;
  if (property == "CFG_LOG")
    return Protocol::Property::CFG_LOG;
  if (property == "CFG_LPF")
    return Protocol::Property::CFG_LPF;
  if (property == "CFG_BIAS")
    return Protocol::Property::CFG_BIAS;
  if (property == "CMD_ACTUATE")
    return Protocol::Property::CMD_ACTUATE;
  if (property == "CMD_TRIGGER")
    return Protocol::Property::CMD_TRIGGER;
  if (property == "LOG")
    return Protocol::Property::LOG;
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown Protocol::Property: " + property);
#else
  return Protocol::Property::NONE;
#endif
}
