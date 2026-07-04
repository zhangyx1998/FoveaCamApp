// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

namespace Protocol {

namespace Version {

// v1.0.0: Protocol v2 — FIN completion method, seq==0 fire-and-forget,
// CMD_STREAM/CMD_FRAME, uint64 timestamps. Breaking change for
// CMD_ACTUATE/CMD_TRIGGER timing semantics (now two-phase ACK/FIN).
constexpr uint8_t Major = 1;
constexpr uint8_t Minor = 0;
constexpr uint8_t Patch = 0;

} // namespace Version

} // namespace Protocol
