// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

#include <Protocol/Packet.h>

// Triggered L/R capture engine (Protocol v2 CMD_FRAME). Owns the per-stream
// FIFO request queue and the non-blocking trigger/strobe state machine;
// mirror targets themselves live in Streams.h. The wire-facing GET handler
// (firmware/src/Protocol.cpp) validates+enqueues via `enqueue()` and sends
// the synchronous ACK/REJ; asynchronous completion (FIN, or REJ on strobe
// timeout) is sent directly by tick().
namespace Capture {

using Packet::Command::Microseconds;

// Validates and enqueues a CMD_FRAME GET request (system-enabled check is
// the caller's responsibility, matching the other CMD_* handlers). Returns
// true and fills `accepted` on success. Returns false and points `reason` at
// a REJ message (static storage, safe to send immediately) otherwise:
// unknown/out-of-range stream, duplicate-stream in-flight/queued request,
// queue full, invalid camera mask, or the unconnected center camera (C).
// `settle_time` (µs, v2.0) holds the trigger that long after a stream SWITCH
// (0 = fire immediately, the pre-v2.0 behavior); see Capture.cpp startNext().
bool enqueue(Protocol::Sequence seq, uint8_t stream, uint8_t cameras,
             Microseconds pulse, Microseconds settle_time,
             Packet::Command::FrameAccepted &accepted, const char *&reason);

// Attaches strobe ISRs on the L/R camera `input` pins. Call once from
// setup().
void init();

// Advances the trigger/strobe timing state machine: drops the trigger pulse
// after `pulse` us, detects the strobe latch set by the ISRs, detects
// completion (or timeout) and sends FIN/REJ, then starts the next queued
// request. Call every loop() iteration.
void tick();

// REJects every queued/in-flight request with `reason` and empties the
// queue (e.g. on System::Enable(false)). Does not touch the stream table —
// callers that also want to clear streams should call Streams::clear().
void cancelAll(const char *reason);

} // namespace Capture
