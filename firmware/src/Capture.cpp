// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <Arduino.h>

#include <Protocol/Packet.h>
#include <Protocol/Protocol.h>

#include "Board.h"
#include "Capture.h"
#include "Global.h"
#include "Streams.h"

namespace Capture {

using Packet::Command::CAM_C;
using Packet::Command::CAM_L;
using Packet::Command::CAM_R;
using Packet::Command::Frame;
using Packet::Command::FrameResult;
using Packet::Command::MirrorPosition;
using Packet::Command::Timestamp;

static constexpr uint8_t QUEUE_CAPACITY = 8;
// Both trigger outputs Frame requests can drive today (C has no strobe
// cable — camera-side size constraints, see docs/refactor/synced-capture.md
// §2/§8).
static constexpr uint8_t SUPPORTED_CAMERAS = CAM_L | CAM_R;
// Fixed margin added to `pulse` before a strobe REJ-timeout fires. Not yet
// bench-verified (docs/refactor/synced-capture.md §4) — revisit once a
// logic analyzer trace of real strobe timing is available.
static constexpr Timestamp STROBE_MARGIN_US = 5000;

struct Request {
  Protocol::Sequence seq;
  uint8_t stream;
  uint8_t cameras;
  Microseconds pulse;
};

template <typename T, uint8_t N> struct Ring {
  T items[N];
  uint8_t head = 0;
  uint8_t count = 0;

  bool full() const { return count >= N; }
  bool empty() const { return count == 0; }
  uint8_t size() const { return count; }

  T &at(uint8_t index) { return items[(head + index) % N]; }

  bool push(const T &value) {
    if (full())
      return false;
    items[(head + count) % N] = value;
    count++;
    return true;
  }

  T pop() {
    T value = items[head];
    head = (head + 1) % N;
    count--;
    return value;
  }
};

static Ring<Request, QUEUE_CAPACITY> queue;

static bool busy = false;
static Request active;
static Timestamp triggerStart = 0;
static bool triggerDropped = false;

// exposureLatched: set once by the ISR (see onStrobeEdge) when the first
// requested camera strobe-rises; only ever cleared by startNext() (main
// loop). Acts as the ISR→main-loop ordering guard for everything below it.
static volatile bool exposureLatched = false;
// Raw hardware microsecond sample taken *in the ISR* — not Global::time,
// whose (counter, anchor) update is a non-atomic read-modify-write also
// performed by loop(); an ISR calling Global::time.now() could preempt that
// update mid-flight and corrupt the counter (§9 FW3a). tick() (main-loop
// only) translates this into the wide Global::time domain once, below.
static volatile uint32_t exposureLatchRawMicros = 0;
static bool exposureLatchTranslated = false; // main-loop-only
static Timestamp exposureLatchTime = 0;      // main-loop-only, once translated
// Not volatile: only ever written by an ISR, then read by tick() after it
// observes exposureLatched==true — that (volatile) flag is the ordering
// guard, avoiding the deprecated volatile-struct-copy pattern.
static MirrorPosition exposureLeft;
static MirrorPosition exposureRight;
// Bit set while the corresponding camera's strobe input is currently high.
static volatile uint8_t strobeHighMask = 0;
// Bit set once the corresponding camera has strobe-risen at least once this
// request — distinct from strobeHighMask (current level): without this, a
// camera that never rises at all (e.g. unplugged/dead) never blocks
// completion, and once the *other* camera falls the request FINs as success
// with only one camera actually exposed (§9 FW2).
static volatile uint8_t risenMask = 0;
// Requested camera bits this request is still waiting to see fall.
static volatile uint8_t awaitingFallMask = 0;

static inline bool queueFull() { return queue.full(); }

static inline bool duplicateStream(uint8_t stream) {
  for (uint8_t i = 0; i < queue.size(); i++)
    if (queue.at(i).stream == stream)
      return true;
  return busy && active.stream == stream;
}

static void writeTrigger(uint8_t cameras, uint8_t level) {
  if (cameras & CAM_L)
    Board::camera[1].output.write(level);
  if (cameras & CAM_R)
    Board::camera[2].output.write(level);
}

// Common strobe-edge handler for both camera inputs; `bit` identifies the
// camera in CameraMask terms, `pin` is that camera's Board::camera input pin.
static inline void onStrobeEdge(uint8_t bit, unsigned pin) {
  if (digitalReadFast(pin)) {
    strobeHighMask |= bit;
    risenMask |= bit;
    if (!exposureLatched && (awaitingFallMask & bit)) {
      // First requested camera to strobe-rise for this request: latch a raw
      // micros() sample (see exposureLatchRawMicros above — NOT
      // Global::time.now(), that's the whole point) + the mirror target
      // actually driving the DAC right now (Stream UPDATEs keep applying
      // independently of this ISR).
      exposureLatchRawMicros = micros();
      MirrorPosition left, right;
      Streams::snapshot(left, right);
      exposureLeft = left;
      exposureRight = right;
      exposureLatched = true;
    }
  } else {
    strobeHighMask &= ~bit;
  }
}

static void onStrobeLeft() {
  onStrobeEdge(CAM_L, Board::camera[1].input.number);
}

static void onStrobeRight() {
  onStrobeEdge(CAM_R, Board::camera[2].input.number);
}

static void sendResult(const Request &req) {
  FrameResult result{req.stream, triggerStart, exposureLatchTime,
                     exposureLeft, exposureRight};
  auto packet = Frame::Create::FIN(req.seq);
  packet.setData(&result, sizeof(result));
  Protocol::send(packet);
}

static void finishActive(const char *rejectReason) {
  Streams::setPendingFrame(active.stream, false);
  if (rejectReason)
    Frame::reject(active.seq, rejectReason);
  else
    sendResult(active);
  busy = false;
}

static void startNext() {
  if (busy || queue.empty())
    return;
  active = queue.pop();
  busy = true;
  triggerDropped = false;
  exposureLatched = false;
  exposureLatchTranslated = false;
  // Compound read-modify-write on ISR-shared volatiles: without disabling
  // interrupts, an onStrobeEdge() firing between the load and the store
  // could have its own update overwritten by this one (§9 FW3b).
  noInterrupts();
  strobeHighMask &= static_cast<uint8_t>(~active.cameras); // drop stale level
  risenMask &= static_cast<uint8_t>(~active.cameras);      // drop stale rise
  interrupts();
  awaitingFallMask = active.cameras;

  Streams::activate(active.stream);
  Streams::tick(); // commit the target before the trigger fires

  triggerStart = Global::time.now();
  writeTrigger(active.cameras, HIGH);
}

bool enqueue(Protocol::Sequence seq, uint8_t stream, uint8_t cameras,
            Microseconds pulse, Packet::Command::FrameAccepted &accepted,
            const char *&reason) {
  if (cameras == 0)
    cameras = SUPPORTED_CAMERAS;
  if (cameras & CAM_C) {
    reason = "Center camera (C) has no strobe cable connected";
    return false;
  }
  if (cameras & ~SUPPORTED_CAMERAS) {
    reason = "Invalid camera mask";
    return false;
  }
  if (!Streams::exists(stream)) {
    reason = "Unknown stream";
    return false;
  }
  if (duplicateStream(stream)) {
    reason = "Stream already has a pending frame request";
    return false;
  }
  if (queueFull()) {
    reason = "Frame queue is full";
    return false;
  }
  accepted.queue_position = queue.size();
  queue.push(Request{seq, stream, cameras, pulse});
  Streams::setPendingFrame(stream, true);
  return true;
}

void init() {
  attachInterrupt(Board::camera[1].input.number, onStrobeLeft, CHANGE);
  attachInterrupt(Board::camera[2].input.number, onStrobeRight, CHANGE);
}

void tick() {
  if (busy) {
    if (!triggerDropped &&
        Global::time.now() - triggerStart >= active.pulse) {
      writeTrigger(active.cameras, LOW);
      triggerDropped = true;
    }
    if (exposureLatched && !exposureLatchTranslated) {
      // Translate the ISR's raw micros() sample into the wide Global::time
      // domain here, in the main loop, where touching Global::time's
      // internal state can't race an ISR (§9 FW3a). Unsigned subtraction on
      // the raw 32-bit sample is wraparound-correct as long as this runs
      // within one micros() wrap of the latch (trivially true — at most one
      // loop() iteration later).
      uint32_t elapsedSinceLatch =
          static_cast<uint32_t>(micros()) - exposureLatchRawMicros;
      exposureLatchTime = Global::time.now() - elapsedSinceLatch;
      exposureLatchTranslated = true;
    }
    // Every requested camera must have both risen (risenMask) and returned
    // low (cleared from strobeHighMask) — requiring risenMask too is what
    // stops a camera that never strobes at all from producing a silent
    // "successful" FIN off the other camera's fall alone (§9 FW2).
    bool exposureOver = exposureLatched && risenMask == active.cameras &&
                        (strobeHighMask & awaitingFallMask) == 0;
    bool timedOut =
        Global::time.now() - triggerStart > active.pulse + STROBE_MARGIN_US;
    if (exposureOver)
      finishActive(nullptr);
    else if (timedOut)
      finishActive("Strobe timeout");
  }
  startNext();
}

void cancelAll(const char *reason) {
  if (busy) {
    writeTrigger(active.cameras, LOW);
    finishActive(reason);
  }
  while (!queue.empty()) {
    auto req = queue.pop();
    Streams::setPendingFrame(req.stream, false);
    Frame::reject(req.seq, reason);
  }
}

} // namespace Capture
