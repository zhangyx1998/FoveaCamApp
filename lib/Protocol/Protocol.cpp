// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <convert.h>

#include "Protocol.h"

template <> std::string convert(const Protocol::Method &method) {
  switch (method) {
#define FOVEA_PROTOCOL_METHOD_TO_STRING(Name, Value)                           \
  case Protocol::Method::Name:                                                 \
    return #Name;
    FOVEA_PROTOCOL_METHODS(FOVEA_PROTOCOL_METHOD_TO_STRING)
#undef FOVEA_PROTOCOL_METHOD_TO_STRING
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
#define FOVEA_PROTOCOL_METHOD_FROM_STRING(Name, Value)                         \
  if (method == #Name)                                                         \
    return Protocol::Method::Name;
  FOVEA_PROTOCOL_METHODS(FOVEA_PROTOCOL_METHOD_FROM_STRING)
#undef FOVEA_PROTOCOL_METHOD_FROM_STRING
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown Protocol::Method: " + method);
#else
  return Protocol::Method::NOP;
#endif
}

template <> std::string convert(const Protocol::Property &property) {
  switch (property) {
#define FOVEA_PROTOCOL_PROPERTY_TO_STRING(Name, Value)                         \
  case Protocol::Property::Name:                                               \
    return #Name;
    FOVEA_PROTOCOL_PROPERTIES(FOVEA_PROTOCOL_PROPERTY_TO_STRING)
#undef FOVEA_PROTOCOL_PROPERTY_TO_STRING
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
#define FOVEA_PROTOCOL_PROPERTY_FROM_STRING(Name, Value)                       \
  if (property == #Name)                                                       \
    return Protocol::Property::Name;
  FOVEA_PROTOCOL_PROPERTIES(FOVEA_PROTOCOL_PROPERTY_FROM_STRING)
#undef FOVEA_PROTOCOL_PROPERTY_FROM_STRING
#if defined(__EXCEPTIONS) || defined(__cpp_exceptions)
  throw std::invalid_argument("Unknown Protocol::Property: " + property);
#else
  return Protocol::Property::NONE;
#endif
}
