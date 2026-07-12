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
// v1.1.0: SYS_TIMESTAMP clock-calibration property (GET = parse-time µs
// stamp, SET = counter reset). Backward-compatible addition.
// v2.0.0: CMD_FRAME payload grows a trailing `settle_time` (µs) — a trigger
// HOLD applied only on a stream SWITCH (see Packet.h Frame + Capture.cpp
// startNext). BREAKING: the fixed-size CMD_FRAME payload changed length, and
// FixedSizePacket::inflate is exact-size, so firmware/core/host must ship as a
// matched set for this version. settle_time == 0 reproduces v1.x behavior
// byte-for-byte on the wire once both ends are rebuilt.
// v2.1.0: SYS_RESET gains a `MEMS` type (2) — a targeted DAC recovery that
// re-inits the AD5664R DACs in place (full re-init incl. RESET) without a
// reboot or a Board::enable rail cycle, then re-commits the active stream's
// targets (firmware Protocol.cpp HANDLE_SET(System::Reset); mitigation M2 in
// docs/dev/right-dac-freeze-2026-07-12.md). Backward-compatible addition: the
// wire layout is unchanged, and older firmware REJects the unknown reset type.
constexpr uint8_t Major = 2;
constexpr uint8_t Minor = 1;
constexpr uint8_t Patch = 0;

} // namespace Version

} // namespace Protocol
