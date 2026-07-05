// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <cstdint>

#include <Protocol/Packet.h>

// Named, continuously-updatable mirror-position targets (Protocol v2
// CMD_STREAM — named `Streams` here, plural, to avoid colliding with the
// Packet::Command::MirrorStream wire-packet type). Latest-target-wins: a stream
// holds one current L+R target, updated by (usually fire-and-forget) UPDATE
// requests. The MEMS DAC always tracks whichever stream is currently
// `active()` — switched by the frame engine (Capture.h) when a CMD_FRAME
// request on a different stream starts.
namespace Streams {

using Packet::Command::MirrorPosition;

constexpr uint8_t CAPACITY = 64;
constexpr uint8_t INVALID_ID = 0xFF;

// True if `id` was CREATEd and not yet TERMINATEd.
bool exists(uint8_t id);
// True if a frame request is queued or in-flight on this stream (blocks
// TERMINATE; used by Capture to REJect duplicate-stream frame requests).
bool hasPendingFrame(uint8_t id);
void setPendingFrame(uint8_t id, bool pending);

bool create(uint8_t id, const MirrorPosition &left, const MirrorPosition &right);
bool update(uint8_t id, const MirrorPosition &left, const MirrorPosition &right);
// Fails (returns false) if the stream has a pending frame request.
bool terminate(uint8_t id);

// Switches the physically-applied ("active") stream. Fails if `id` doesn't
// exist. Forces a DAC write on the next tick() even if the target is
// unchanged, so the new stream's position is committed before a trigger.
bool activate(uint8_t id);
uint8_t active();

// Snapshot of the active stream's current (possibly mid-update) target;
// INVALID_ID leaves both positions zeroed. Used to latch mirror positions
// into the FrameResult at strobe rise.
void snapshot(MirrorPosition &left, MirrorPosition &right);

// Call every loop() tick: writes the active stream's target to the MEMS DAC,
// skipping the SPI write when the target hasn't changed since the last tick.
void tick();

// Terminates every stream unconditionally (e.g. on System::Enable(false)).
void clear();

} // namespace Streams
