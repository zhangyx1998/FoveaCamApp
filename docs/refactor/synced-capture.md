# Plan: Hardware-Synced Stereo Capture, Position Streams & Protocol v2

> **Status:** Stage 3 synced-capture work ✅ through Round 2 **T6** (§9.10).
> Remaining live-capture work is hardware-gated: bench (Stage F) → flash → P4 wiring
> → P5. The original FIN-timeout root cause remains **undetermined pending
> the next bench run** (§9.7's trace makes it decisive). Stop here for the
> planner review / commit checkpoint #2 — ✅ done 2026-07-04.
> **STAGE 3 (2026-07-05):** Round 1 — **T3** (round-robin frame scheduler,
> §9.9) + **T4** (multi-fovea skeleton, §9.9) ✅ planner-verified. Round 2 —
> **T6** (core `Tracker.updateAsync()` via AsyncTask + concurrent
> multi-fovea tracker updates, §9.10) ✅ landed, ✓ planner-verified against
> code. **Round 3 T8 fixed the V5 late-async-completion leak in
> `MultiFoveaRuntime.syncStreams()`: late `createStream` completions are
> generation-guarded, stale handles close immediately, and target changes
> during an in-flight sync dirty-rerun.**
> **Branch:** TBD (new branch off `refactor/decouple-orchestrator` or after it merges).
> **Owner:** Yuxuan (plan) / separate coder (implementation).
> **Last updated:** 2026-07-05
> **Related:** [`orchestrator.md`](./orchestrator.md) (host-side architecture; the
> controller session owns the serial device this plan extends),
> [`stream-hot-path.md`](./stream-hot-path.md) (in-flight `core` Frame/Stream
> type changes; Frame timestamp plumbing is now landed in `core`).

---

## 1. Goal

Today all three cameras free-run and the L/R foveae are paired with mirror
state only by "whatever was actuated recently" — no synchronization. Target:

1. **Hardware-triggered L/R capture.** The Teensy triggers the left and right
   fovea cameras; the center camera keeps free-running (latest-frame display,
   unchanged). The host pairs L/R frames belonging to the same trigger by
   **Teensy timestamps** carried in the completion response, after an initial
   clock-delta calibration (one triggered frame before the loop starts).
2. **Position streams.** Within each exposure window the mirrors keep
   updating continuously. A *stream* is a named, continuously-updatable
   mirror-position target: frame request N names the stream its exposure
   follows (frame 1 → stream 1, frame 2 → stream 2, …). This is the infra for
   **multi-fovea**: current modules use one stream; a future multi-tracking
   module runs many, interleaving frame requests across them.
3. **Protocol v2.** Separate "command received" (**ACK**) from "request
   completed" (new method **FIN** — "finished"; chosen to match the enum's
   TCP-flag lineage and three-letter grammar: `SYN`/`ACK`/`REJ`/`FIN`).
   Refactor the host API around two-phase requests while keeping DX at
   least as smooth as today (`await` still means "completed").

## 2. Pre-v2 state (historical — what the plan started from)

> Everything below described the tree **before** P1/P2 landed; kept as the
> plan's baseline reference. For as-built state see §3–§6 + §9.

**Wire protocol** (`lib/Protocol/`, shared host+firmware; COBS-framed over USB
CDC serial — `Serial.begin(115200)` is nominal, real throughput is USB-speed):
- 1-byte header packs `Method` (upper nibble: NOP/GET/SET/ACK/REJ/SYN) and
  `Property` (lower nibble) + `uint16` sequence + XOR checksum
  (`Protocol.h`). **Property space is 4 bits**; used: 0x01–0x07, 0x0A
  (CMD_ACTUATE), 0x0B (CMD_TRIGGER), 0x0F (LOG). **Free: 0x08, 0x09, 0x0C,
  0x0D, 0x0E.** Version handshake exists (`Version.h`, `System::Version`).
- Typed payloads via `FIXED_SIZE_PACKET` prototypes (`Packet.h`); per-method
  handlers dispatched by a `switch` in `firmware/src/Firmware.cpp`.

**Firmware** (`firmware/src/`, Teensy 4.0):
- **Fully synchronous.** `loop()` reads one serial byte per iteration and
  dispatches complete packets. `Command::Actuate` blocks in
  `delayMicroseconds(settle_time)`; `Command::Trigger` blocks for the pulse
  width and fires **all** camera outputs (`Protocol.cpp`). The ACK *is* the
  completion signal today, and nothing can update mirrors mid-exposure.
- **Board** (`firmware/src/Board.h`): per-camera pinout has an **`input` pin**
  (CAM0 C {20,21}, CAM1 L {22,23}, CAM2 R {18,19}) — for camera strobe /
  exposure-active feedback, **currently unused in firmware**. **The center
  camera (CAM0) port is reserved on the board but has no cable plugged in**
  (size constraints at the camera prevent a GPIO cable) — only L/R can be
  triggered or strobe-timestamped today; the center free-runs by hardware
  fact. The capability is recoverable with a cable solution, no board
  change needed. MEMS via SPI + per-mirror CS;
  `MEMS::set(device, pos)` + `MEMS::apply()`.
- **Clock** (`firmware/include/Time.h`, `Global::time` = `Time<micros>`):
  `uint32` µs counter → wraps at ~71.6 min, and **`reset(0)` on every system
  enable** (`Protocol.cpp` `System::Enable`). Any host↔MCU clock delta is
  invalidated by enable — calibration must rerun after each enable.

**Host:**
- `core/src/Controller.cpp` — `Device` with a pending-request map keyed by
  sequence; the **first** matching response resolves (ACK) or rejects (REJ)
  the JS promise and erases the entry. Responses with `seq == 0` are ignored
  (logged as unmatched only when `seq != 0`) — usable as a fire-and-forget
  convention.
- `app/orchestrator/controller.ts` — `Controller` class over `Device`
  (enable/disable, bias/LPF, `actuate`, `trigger`); module-level
  `activeController()` shared with control-loop sessions; exposed to the
  renderer via the `controller` session + `useControllerClient()` facade.
- Camera side: the orchestrator registry (`app/orchestrator/registry.ts`)
  owns one shared `Camera` + preview loop per serial. Frames currently carry
  **no timestamps** to JS (`FramePayload {data, shape, channels}`).

## 3. Protocol v2 design

### 3.1 New method: completion

```cpp
typedef enum Method : uint8_t {
  NOP = 0x00,
  GET = 0x10, SET = 0x20,          // requests
  ACK = 0x30, REJ = 0x40,          // received-and-accepted / refused
  FIN = 0x50,                      // request completed ("finished")
  SYN = 0xF0,                      // unsolicited push
} Method;
```

Semantics:
- **ACK** — request received, validated, and accepted (queued or applied).
  Sent immediately, never blocks. Carries a property-specific payload where
  useful (e.g. queue position).
- **FIN** — the accepted request finished; same property + same sequence as
  the original request. Carries the result payload.
- **REJ** — terminal at either phase: validation failure (instead of ACK) or
  runtime failure (instead of FIN, e.g. strobe timeout).
- Simple config/get properties stay **single-phase** (ACK is terminal, no
  FIN) — zero behavior change for them. Long-running commands
  (`CMD_ACTUATE`, `CMD_TRIGGER`, and the new `CMD_FRAME`) become two-phase.
- **`seq == 0` request = fire-and-forget**: firmware sends no response
  (the host already drops seq-0 responses). Used for high-rate stream
  updates.
- Bump `Version.h` (this is a breaking change for ACTUATE/TRIGGER timing
  semantics); `Controller.ready` should verify the version at connect and
  surface a mismatch as a connect error.

### 3.2 New properties

Two of the five free nibble slots:

```cpp
CMD_STREAM = 0x08,   // per-stream lifecycle + position updates
CMD_FRAME  = 0x09,   // triggered-frame request
```

(If the nibble ever runs out, the escape hatch is widening Property to a full
byte in a v3 header — noted, not needed now.)

**`CMD_STREAM`** — SET with an op byte; separate ops per stream as required:

```cpp
FIXED_SIZE_PACKET(Stream, CMD_STREAM) {
  typedef enum Op : uint8_t { CREATE = 0, UPDATE = 1, TERMINATE = 2 } Op;
  Op op;
  uint8_t id;                    // stream id, host-chosen (0..N-1)
  Command::MirrorPosition left;  // target; ignored by TERMINATE
  Command::MirrorPosition right;
};
```

- Stream model: **latest-target-wins**. A stream holds one current L+R
  target; the firmware MEMS tick continuously applies the *active* stream's
  target. The host's existing ~1 kHz actuation loop becomes a stream of
  `UPDATE`s (`seq=0`, fire-and-forget).
  **Activation semantics (resolved 2026-07-04, planner — prompted by the
  user's "does an enabled controller follow stream 0?" question, which
  exposed a gap):** as first implemented, a stream only became *active*
  when a CMD_FRAME request started (`Capture::startNext` was
  `Streams::activate`'s sole caller), so an enabled controller with
  streams created and UPDATEs flowing — but no frame request — moved
  **nothing**; streams-as-actuation only worked mid-capture, defeating
  the "UPDATE replaces the 1 kHz Actuate loop" goal for free-running
  control. **Decision: CREATE auto-activates when no stream is currently
  active** (`activeId == INVALID`). Single-stream apps get exactly the
  intuitive behavior (create stream 0 → mirrors follow it immediately);
  multi-stream apps get "first created" until the first frame request,
  after which the followed stream is the most recent frame request's
  (unchanged — that persistence *is* the §1 per-exposure semantics).
  TERMINATE of the active stream freezes mirrors at the last applied
  target (`activeId → INVALID`); an explicit `ACTIVATE` op is **deferred**
  until a multi-fovea consumer needs host-controlled following outside
  frame requests. Firmware change is one line in `Streams::create` +
  a bench check (Stage F: after CREATE, UPDATEs move the DAC with no
  frame request in flight) — assigned to this thread.
  Trajectory playback (queued
  timestamped waypoints) is a future extension of `Op`, not v2 scope.
- `CREATE`/`TERMINATE` are normal two-way requests (ACK/REJ; single-phase).
  REJ on: duplicate CREATE, unknown id, id out of range, or TERMINATE while
  a frame request on that stream is pending.
- Firmware stream table: fixed small capacity (propose 8), static allocation.

**`CMD_FRAME`** — the triggered capture request (GET, two-phase):

```cpp
FIXED_SIZE_PACKET(Frame, CMD_FRAME) {          // GET payload
  uint8_t stream;        // stream the mirrors follow during this exposure
  uint8_t cameras;       // bitmask {C=1, L=2, R=4}; default L|R.
                         // C is reserved: the CAM0 port has no cable
                         // (camera-side size constraints) — firmware
                         // REJects a mask containing C until one is
                         // connected.
  Command::Microseconds pulse;  // trigger pulse width
};

PACKED(FrameResult) {                          // FIN payload
  uint8_t stream;
  uint64_t t_trigger;    // MCU µs: trigger rise
  uint64_t t_exposure;   // MCU µs: strobe rise (exposure start)
  Command::MirrorPosition left;   // latched at exposure start
  Command::MirrorPosition right;
};
```

- **Queueing:** requests on *different* streams queue FIFO (propose depth 8);
  a request on a stream that already has a pending/queued request is
  **REJ**ected (duplicate rejection, per requirement). ACK carries the queue
  position.
- **Note (refines the original ask):** "initial mirror position at exposure
  start" can only exist *at* exposure start, so it rides the **FIN**
  (completion) payload, not the ACK — the ACK/FIN split the same revision
  introduces is what makes this coherent.
- **Execution per request:** switch active stream → raise trigger on the
  masked cameras' output pins → on strobe **rising edge** (camera `input`
  pin ISR) latch `Global::time.now()` + current L/R DAC targets into the
  in-flight record → drop trigger after `pulse` (non-blocking timer) → on
  strobe falling edge (or a timeout ≈ exposure + margin → REJ) send FIN →
  start the next queued request. Mirror `UPDATE`s keep applying throughout —
  that is the point.

### 3.3 Existing commands under v2

- `CMD_ACTUATE`: ACK immediately; FIN (with `complete_time`) after
  `settle_time` elapses on a non-blocking timer. Payload unchanged.
- `CMD_TRIGGER`: kept as the raw "fire all outputs now" escape hatch —
  ACK immediately, FIN (with timestamp) after the pulse. Used by the clock
  calibration if `CMD_FRAME` feels too heavy; otherwise candidates for
  deprecation once `CMD_FRAME` is proven.
- Timestamps in new payloads are **`uint64` µs**. Widen the firmware counter
  to `Time<micros, uint64_t>` (the template already supports a wider counter
  type than the anchor) so wrap handling stays firmware-side only.

## 4. Firmware rework (the enabler)

The scheduler change is the prerequisite for everything above:

- **Non-blocking `loop()`**: keep draining serial + dispatching, plus tick:
  (a) MEMS update — apply the active stream's latest target (skip SPI write
  if unchanged); (b) frame state machine — trigger pulse timing via
  `elapsedMicros`/`IntervalTimer`, strobe timeout check; (c) `Actuate`
  settle timers. **No `delayMicroseconds` in any handler.**
- **Strobe ISRs**: `attachInterrupt` on each camera `input` rising+falling
  edge; rising latches time + mirror positions into the in-flight frame
  record (keep the ISR tiny: copy fields, set a flag; FIN is sent from the
  main loop).
- **Rejections** (all REJ with reason string, matching existing style):
  system not enabled; unknown/duplicate stream; queue full; strobe timeout;
  TERMINATE with pending frame.
- `System::Enable` disable path must cancel queued/in-flight frame requests
  (REJ them) and clear the stream table (or keep streams but REJ in-flight —
  decide during implementation; document the choice in this file).

**Bench verification (per AGENTS.md, name the concrete check):** logic
analyzer or scope on trigger output + strobe input while sending `CMD_FRAME`
from a serial test script; confirm (1) ACK precedes trigger, (2) mirror
`UPDATE`s visibly move the DAC during the strobe-high window, (3) FIN
timestamps match scope timing, (4) duplicate-stream request REJects, (5)
queued cross-stream requests fire in order. Requires confirming the physical
wiring for **L and R** (CAM1/CAM2): camera strobe → Teensy `input` pins, and
configuring the FLIR line output as ExposureActive. (CAM0/center has no
physical GPIO connection — nothing to verify there.)

## 5. Host `core` changes (`core/src/Controller.cpp`)

- **Two-phase pending map.** A pending entry holds *two* resolvers. ACK
  resolves the `accepted` promise and keeps the entry; FIN resolves the
  `completed` promise and erases it; REJ rejects whichever phase is
  outstanding and erases. Single-phase properties (everything but CMD_*)
  keep today's resolve-on-ACK-and-erase path.
- **JS request shape (DX-preserving).** `device.request(prop, arg)` returns a
  thenable that resolves on **FIN** — so `await ctl.actuate(...)` keeps
  meaning "movement complete", exactly like today's blocking firmware made it
  mean — with an `.accepted` promise attached for pipelining:

  ```ts
  const req = ctl.frame({ stream: 1 });
  await req.accepted;        // ACK: queued (throws on REJ)
  const info = await req;    // FIN: { tExposure, left, right, ... }
  ```

- New packet definitions mirrored in the native module + **hand-written
  `.d.ts` updates** (`core/dist/Controller/index.d.ts` — types are not
  auto-generated; see AGENTS.md).
- **`Frame` timestamps (core/Aravis).** Host-side matching needs per-frame
  device timestamps in JS: expose the Aravis buffer timestamp(s)
  (`arv_buffer_get_timestamp`/`_get_system_timestamp`) on `Frame` (and keep
  the extract-before-`release()` rule). **Coordinate with the stream
  hot-path thread** — they are actively editing `Iterator.h`/`Stream.h`/
  `types.d.ts`.

## 6. Orchestrator changes

- **`controller.ts` API** (all consumers go through `activeController()`):

  ```ts
  ctl.createStream(): Promise<StreamHandle>   // ACK-backed
  interface StreamHandle {
    readonly id: number;
    update(pos: { left?: Pos; right?: Pos }): void;  // seq=0 fire-and-forget
    close(): Promise<void>;
  }
  ctl.frame(opts: { stream: number; cameras?: CamMask; pulse?: number })
    : FrameRequest;  // thenable → FrameResult, with .accepted
  ```

  Voltage↔DAC conversion stays in `@lib/controller-codec`.
- **Camera trigger config.** L/R switch to `TriggerMode=On` /
  `TriggerSource=Line<N>` (+ line/strobe output = ExposureActive) when synced
  capture starts, and back to free-run on stop. Verify the Aravis binding
  exposes trigger configuration (`arv_camera_set_trigger`) — add to `core`
  if missing. Config flows through the registry's `lease.reconfigure()` so
  the shared preview loop restarts cleanly.
- **Sync service (`app/orchestrator/sync.ts`, new).** Owns:
  - **Clock calibration:** after every controller `enable()` (MCU clock
    resets!) and before the capture loop: issue one calibration
    `ctl.frame({stream: calib})`, read the L/R frames' device timestamps,
    compute per-camera `delta = ts_camera − t_exposure_mcu`.
  - **Matching:** for each subsequent FIN, pair the L and R frames whose
    device timestamps fall within tolerance (± half the minimum frame
    interval) of `t_exposure + delta`. Deliver
    `{ L: Frame, R: Frame, mirror: {left, right}, tExposure }`; center stays
    the registry's free-running latest frame.
  - Timestamp taps ride the registry sink path — fold the per-frame
    timestamp into the `FramePayload`/sink meta being added by the
    **transport-observability goal** (orchestrator.md roadmap 3); one meta
    header serves both.
- **Sessions.** `tracking-single` (and later `disparity`) swap their
  actuation writes to `stream.update(...)` and their center-driven capture
  to `sync` pairs — **single stream**, no contract changes required beyond
  telemetry additions. The future **multi-tracking module** creates N
  streams and interleaves `ctl.frame({stream: k})` round-robin — the queue +
  duplicate-rejection semantics above are exactly what makes that safe.

## 7. Phasing (each independently landable)

1. **P1 — protocol lib v2** (`lib/Protocol/*`): FIN method, seq-0
   convention, CMD_STREAM/CMD_FRAME payloads, uint64 time, version bump.
   Compiles on both sides; `make clean` in `firmware/` afterwards (PlatformIO
   copies `lib/` — see AGENTS.md). **[coder] Done 2026-07-03; ✓
   planner-verified** (one carve-out: the uint64 *counter* half was never
   done — tracked as FW1, §9, **now fixed**).
2. **P2 — firmware scheduler + streams + frame engine** (§4). **[coder]
   Implemented 2026-07-03; planner-reviewed — structure verified (Streams/
   Capture split, no blocking delays, strobe ISRs, disable-clears-all,
   CAM_C REJ). FW1–FW3 (§9) fixed 2026-07-03; bench pass (§4) still
   outstanding — needs real hardware, not available in this environment.**
3. **P3 — host `core`**: two-phase Device, new packets, `.d.ts`, Frame
   timestamps (coordinate with hot-path thread). **[planner 2026-07-03]
   Substantially landed (unlogged by the coder — reviewed after the fact,
   §9.3): two-phase `PendingRequest`, new packet factories, `.accepted` on
   the returned promise. Remainder = P3.1 (§9.3): version check +
   v1-compat fallback, `core/dist/Controller/index.d.ts`, Frame device
   timestamps.** **[coder] P3.1a+P3.1b done 2026-07-04 (§9.4)** — version
   check + v1-compat fallback (`Device.verifyVersion`/`v2Capable`), `.d.ts`
   updated (MirrorStream/Frame/FrameAccepted/FrameResult + `TwoPhase`).
   **[coder] P3.1d done 2026-07-04 (§9.6)** — `core/Aravis` `Frame`
   exposes explicit device/system timestamps and registry previews copy them
   into `FrameMeta` before `Frame.release()`.
4. **P4 — orchestrator**: `controller.ts` stream/frame API, camera trigger
   config via registry, `sync.ts` calibration + matching. **[coder] Code-side
   landed 2026-07-04 (§9.5)**: `Controller.createStream`/`frame`,
   `sync.ts` (calibration/matching skeleton + hardware-trigger
   `lease.reconfigure()` helpers). Type-clean, no hardware exercised —
   real wiring (trigger source/line names, live calibration) is
   hardware-gated per §9.5.
5. **P5 — integration**: tracking-single on one stream end-to-end (GUI
   check: tracker + actuation with synced L/R pairs; verify pair timestamps
   monotonic and mirror-position telemetry matches the FIN latches). The
   multi-fovea module comes later on the same infra.

## 8. Open questions

1. **Exposure control** — camera-side ExposureTime with trigger-start only,
   or TriggerWidth mode (exposure = pulse width, firmware-controlled)?
   Affects whether `pulse` is meaningful or just an edge.
2. **Queue/stream capacities** — 8/8 proposed; confirm against multi-fovea
   ambitions. **[coder] Implemented as proposed**
   (`QUEUE_CAPACITY`/`Streams::CAPACITY` both 8 in `firmware/src/Capture.cpp`
   / `firmware/include/Streams.h`).
   **Scaling estimate to 64 streams (planner, 2026-07-04):** wire id is
   already uint8 → no protocol change; RAM ~1.3 kB (noise); hot paths O(1).
   Real costs, in order: (a) **serial intake** — worst case 64×1 kHz
   UPDATEs ≈ 64 k pkt/s ≈ 1.5 MB/s, above the ~1 MB/s ceiling imposed by
   `loop()`'s one-byte-per-iteration `Serial.read()` → chunk-drain
   `Serial.available()` (small; bench-validate via `Device.stats`, Stage
   F); (b) if worst case is real: a batched-UPDATE op (`BufferPacket`,
   N tuples/packet) + host-side batching; frame-queue fairness policy
   (≤ QUEUE_CAPACITY streams can hold pending frames — deepen or
   round-robin); profiler aggregate view beyond ~8 rows. (c) Physics, not
   code: one trigger engine + one L/R pair divide aggregate triggered fps
   (~200 fps at 5 ms exposure) across all streams — 64 streams ≈ 3 fps
   each. **Cheapest deflation: host updates-on-change with per-stream min
   interval** — bandwidth then scales with control activity, not stream
   count, and (b) likely never triggers.
   **→ Approved (user, 2026-07-04): bump to 64.** Work items **ST-64a–c**
   in the Stage 2 assignment list below (this thread); (b)-tier items stay
   conditional on Stage F numbers.
3. ~~**Disable semantics**~~ — **[coder] resolved 2026-07-03: streams do NOT
   survive `System::Enable(false)`.** `System::Enable` SET
   (firmware/src/Protocol.cpp) calls `Capture::cancelAll()` (REJects
   queued/in-flight frame requests) and `Streams::clear()` (terminates every
   stream) on the disable transition, plus REJects any pending
   Actuate/Trigger completion. Rationale: the MCU clock resets on the next
   enable anyway (invalidating any host-side clock-delta calibration), so
   keeping stale stream targets or in-flight frame state around across a
   disable buys nothing, and MEMS is powered down immediately after.
4. **`Actuate`/`Trigger` deprecation** once streams + `CMD_FRAME` are proven.
5. ~~Center-camera strobe timestamping~~ — **resolved 2026-07-03: not
   currently possible.** The CAM0 port is reserved on the board, but size
   constraints at the camera prevent plugging a GPIO cable. Center stays
   free-running; center↔pair association remains software-side (host
   arrival time / nearest-frame). Revisit if a slimmer cable/connector
   solution turns up — firmware/protocol need no changes then (the C mask
   bit is already reserved), just remove the REJ.

## 9. P2 status: coder decisions (accepted) + planner review findings

**Layout (✓ verified):** `Streams.h/.cpp` (mirror-target table + MEMS tick;
named `Streams` to dodge Arduino's global `Stream`; the wire packet is
`Packet::Command::MirrorStream` for the same reason) and `Capture.h/.cpp`
(per-stream FIFO + non-blocking trigger/strobe state machine + L/R strobe
ISRs). `Protocol.cpp` gained `Protocol::tick()` (non-blocking Actuate/Trigger
completion) + the CMD_STREAM/CMD_FRAME handlers; `loop()` ticks
Streams/Capture/Protocol before draining serial; no `delayMicroseconds`
remains in any handler.

**Coder decisions, reviewed and accepted as canon:**
- Exposure-start latched on the *first* rising edge among the masked cameras
  (revisit once the bench trace shows real L/R skew).
- Single timeout `pulse + STROBE_MARGIN_US` (5000 µs placeholder, bench-
  unverified) from trigger-rise.
- Overlapping Actuate/Trigger REJected rather than queued (matches old
  blocking behavior's effect; overlapping writers should use CMD_STREAM).
- `Protocol::send` exported; it is the single enforcement point of the
  seq==0 fire-and-forget convention.

### 9.1 P2.1 fix list — ✅ all fixed, ✓ planner-verified in code (2026-07-03)

- **FW1 ✓ fixed** — uint64 widening was claimed in the P1 log but absent;
  `Global::time` is now `Time<micros, uint64_t>` (verified in
  `Global.h`/`Global.cpp`), so timestamps and FIN deadlines no longer wrap
  at ~71.6 min.
- **FW2 ✓ fixed** — dead camera no longer yields a false-success FIN:
  `risenMask` (set in the ISR, cleared under `noInterrupts` in
  `startNext`) is required to equal `active.cameras` before normal
  completion; a never-strobing camera now falls through to the timeout REJ
  (reason still the generic "Strobe timeout" — acceptable).
- **FW3 ✓ fixed** — ISR no longer calls `Global::time.now()` (raw
  `micros()` latched, translated once in `tick()`); main-loop RMWs on
  ISR-shared masks are interrupt-guarded.
- **FW4 → superseded, see §9.3** — the hazard is now **two-way** since P3
  landed host-side.
- **FW5 ⚪ note only** (Actuate bypasses `Streams` `dirty` bookkeeping —
  don't mix Actuate with streams; no action).
- **FW6 ✓ fixed [coder]** — `Streams::snapshot()` runs in the strobe ISR and
  reads the stream table while a main-loop `Streams::update()` may be
  mid-write — a torn `MirrorPosition` latch, corrupting exactly the value
  the FIN exists to report. `update()`'s two struct writes are now wrapped
  in `noInterrupts()/interrupts()` (`firmware/src/Streams.cpp`).

Coder rebuilt `firmware/` (`pio run`) and `test/` clean. **Bench
verification (§4 checklist) still outstanding — hardware-dependent** (logic
analyzer on a real Teensy + cameras): ACK-before-trigger, mid-exposure
UPDATE visible on the DAC, FIN timestamps vs scope, duplicate-stream REJ,
cross-stream queue order, real `STROBE_MARGIN_US`.

### 9.2 (superseded FW4 history — see git history for the full text)

Original FW4: v1 host resolves on first response, so v2 firmware made
`actuate()` mis-time and every FIN WARN-spam as unmatched. P3's host FIN
support fixes that pairing but creates the mirror-image hazard (§9.3).

### 9.3 P3 review (planner, 2026-07-03) — landed unlogged; this is its record

`core/src/Controller.cpp` (+378 lines) implements P3's host side, with **no
coder log entry anywhere** — the P2.1 coder explicitly disclaimed touching
P3, so this came from a separate, unlogged session. Reviewed after the
fact:

**Verified good:**
- Two-phase `PendingRequest`: ACK resolves `.accepted` and keeps the
  pending-map entry; FIN resolves the terminal value and retires it; REJ is
  terminal at either phase; destructor rejects whatever is outstanding.
- `isTwoPhase` deliberately narrowed to CMD_ACTUATE/CMD_TRIGGER/CMD_FRAME —
  CMD_STREAM stays single-phase (correct: no FIN ever arrives, a two-phase
  entry would leak until close). Sound reasoning, recorded in a comment.
- CMD_FRAME's asymmetric payloads handled via dedicated cached
  FrameAccepted/FrameResult decoders; timestamps decode as BigInt.
- DX matches the plan: `device.set/get(...)` returns the *completed*
  promise with `.accepted` attached (plus a defensive no-op catch so
  ACK-phase REJs don't double-fire unhandled-rejection warnings).
- New packet factories (MirrorStream/Frame/FrameAccepted/FrameResult)
  registered; `Protocol.System.Version` factory exposes the host's own
  Major/Minor/Patch as statics — the ingredients for the version check
  exist, but…

**Gaps — fix list "P3.1", blocking any mixed host/firmware deployment:**
- **P3.1a 🔴 no version check at connect.** Neither `Device` nor
  `app/orchestrator/controller.ts`'s `ready` compares host
  `Protocol.Version` statics against `get(System.Version)`. With the
  rebuilt host and **old (v1) firmware — which is what is physically
  plugged in right now** — every `actuate()`/`trigger()` awaits a FIN that
  never comes and **hangs until disconnect** (entry retired only by the
  destructor's "Request timeout"). This silently breaks tracking-single and
  manual-control actuation in the upcoming GUI session if `core` gets
  rebuilt first. **Fix:** check at connect; on firmware major < 1, either
  refuse with a clear error or (recommended) drop into a v1-compat mode
  that treats two-phase properties as single-phase (resolve on ACK) — that
  unblocks the GUI session without flashing.
- **P3.1b 🔴 `core/dist/Controller/index.d.ts` not updated** — no
  MirrorStream/Frame/FrameAccepted/FrameResult types, no `.accepted` on the
  return type. TS consumers (orchestrator `controller.ts`) are blind to the
  entire v2 API; AGENTS.md requires hand-updating this file with any new
  native surface.
- **P3.1c 🟠 consumers untouched:** `app/orchestrator/controller.ts` still
  exposes only v1 methods (no `createStream`/`frame` per §6);
  `core/test/02-serial-protocol.ts` is fine against v2 firmware once
  rebuilt (its awaited `set(Actuate)` now genuinely completes on FIN) but
  will hang against v1 firmware like everything else — same P3.1a gate.
- **P3.1d ✅ [coder]** Frame *device* timestamps (Aravis buffer → `core`
  Frame, for host-side pair matching) landed 2026-07-04; see §9.6.

**Next for this thread (reordered 2026-07-04 — hardware verification is
deferred several rounds while mechanical work on the rig completes, per
user direction; keep landing code-only work):**
1. **P3.1a + P3.1b + FW6 + P4 code-side + P3.1d** — landed; see
   §9.4-§9.6.
2. **Hardware-gated, queued behind the mechanical work:** bench
   verification (§4 checklist) → flash v2 → P5 integration.

### 9.4 P3.1a/P3.1b/FW6 — [coder] 2026-07-04, planner-✓ verified (review round 3)

- **P3.1a** (`core/src/Controller.cpp`): `DeviceObject` gained a
  `v2_capable` member, defaulting **false** (v1-compat: every property
  resolves on ACK — exactly pre-v2 behavior) — `isTwoPhase(property) &&
  v2_capable` now gates two-phase treatment in `send()`, so `PendingRequest`
  takes `two_phase` as an explicit constructor argument instead of computing
  it itself. New `Device.verifyVersion()` (JS-callable): fetches
  `System.Version`, sets `v2_capable = (firmware.major >=
  Protocol::Version::Major)`, never rejects on a *mismatch* (only on a
  transport/REJ failure) — matches the plan's "recommended" fallback over
  refusing outright. New `Device.v2Capable` read-only getter. This closes
  the hang hazard **structurally** (old firmware talking to a rebuilt host
  can no longer hang, regardless of whether any call site remembers to call
  `verifyVersion()`) — §9.5 additionally wires the call site.
- **P3.1b** (`core/dist/Controller/index.d.ts`): added
  `MirrorStream`/`Frame`/`FrameAccepted`/`FrameResult` types, a `TwoPhase<
  Completed, Accepted>` return-type helper (`Promise<...> & { accepted:
  Promise<...> }`), overloads for `Actuate`/`Trigger`/`Frame` returning
  `TwoPhase<...>` ahead of the generic single-phase fallback (TS resolves
  overloads in declaration order), plus `Device.v2Capable`/`verifyVersion`.
  Verified with a standalone `tsc --noEmit` pass over the `.d.ts` itself and
  a full `vue-tsc --noEmit` over `app/` (existing consumers, e.g.
  `app/orchestrator/controller.ts`'s untyped `private set<T>(prop: any,
  ...)` wrapper, compile unchanged).
- **FW6** (`firmware/src/Streams.cpp`): `update()`'s two `MirrorPosition`
  writes wrapped in `noInterrupts()/interrupts()` — see §9.1.
- Two further additions, both directly required to make P4 (§9.5) possible
  rather than speculative scope creep:
  - `Device.fireAndForget(fn, arg)` (`core/src/Controller.cpp` +
    `core/dist/Controller/index.d.ts`): sends a SET with sequence **0** (no
    pending-map entry, no promise) — the seq==0 fire-and-forget convention
    (§3.1) existed protocol-side and firmware-side (P1/P2) but had **no
    host-side way to invoke it at all** before this; needed for
    `StreamHandle.update()` (§9.5) to actually be fire-and-forget rather
    than a full round-tripped `set()`.
  - Generic GenICam feature access on `core/Aravis`'s `Camera`
    (`get/set/executeFeature`, `core/lib/Aravis/Camera.h` +
    `core/src/Camera.cpp` + `.d.ts`): trigger mode/source already had
    dedicated bindings (`setTrigger`/`trigger_source`/`clearTriggers`, also
    found missing `setTrigger` from the `.d.ts` and added it here), but
    configuring a strobe **line output** as `ExposureActive`
    (`LineSelector`/`LineMode`/`LineSource`, §6) had no binding at all — the
    generic accessor covers that and any other feature without a dedicated
    method, without hand-rolling one binding per GenICam feature name.

All of `core/` (both Node and Electron runtimes), `firmware/`, and `test/`
rebuilt clean (no warnings) after these changes; `app/`'s `vue-tsc --noEmit`
is clean.

### 9.5 P4 code-side — [coder] 2026-07-04, planner-✓ verified (review round 3)

> Planner verification notes: `v2_capable`-gated two-phase in `send()`
> confirmed (structural hang fix — default false = exact v1 behavior);
> `verifyVersion()` wired first in `Controller.ready`; `.d.ts` covers the
> v2 surface incl. `TwoPhase<>`; `sync.ts` correctly isolates the
> arithmetic behind `DeviceTimestamped`, and honestly documents the
> calibration-frame correlation chicken-and-egg;
> `enableHardwareTrigger` rides `lease.reconfigure()` with the new generic
> GenICam accessors. One watch item (minor, no action): `verifyVersion`
> sets `v2Capable = firmware.major >= host.major`, so a hypothetical
> *newer*-major firmware also passes — acceptable until a v3 exists; note
> it when bumping majors.

Per the reordered queue above and docs/refactor/orchestrator.md §7.1 item 7
(hardware verification deferred several rounds for mechanical rig work;
keep landing code-only work in the meantime):

- **`app/orchestrator/controller.ts`**: `Controller.ready` now calls
  `device.verifyVersion()` before anything else (the P3.1a call site P3.1c
  flagged as missing) — a local `const device = this.device` was needed to
  dodge a real `vue-tsc` TS2565 ("used before being assigned") on directly
  reading `this.device` inside the constructor's async closure, a quirk of
  narrowing through closures, not a logic bug. Added `Controller.
  createStream(pos)` (auto-allocates a 0..7 id — `Streams::CAPACITY` —
  tracked in a `Set`, freed on `close()`) returning a `StreamHandle {id,
  update, close}` per §6, and `Controller.frame(opts)` returning
  `Promise<FrameOutcome> & {accepted}` (DAC channels converted to volts,
  matching `actuate()`'s existing convention; `FrameOutcome` is distinct
  from core's raw wire-units `FrameResult`). Both hard-require
  `device.v2Capable` (unlike `actuate`/`trigger`, CMD_STREAM/CMD_FRAME have
  no v1 firmware equivalent at all, so there's no fallback behavior to fall
  back *to*) and throw a clear error otherwise. `update()` uses the new
  `Device.fireAndForget` — see §9.4.
- **`app/orchestrator/sync.ts`** (new): `calibrate()` + `matchesExposure()`/
  `matchPair()` implement §6's clock-calibration and L/R-matching math
  against a `DeviceTimestamped { deviceTimestamp: bigint }` shape. Native
  `core/Aravis` `Frame`s now satisfy that shape via P3.1d, while the math
  remains unit-testable with synthetic timestamp objects. Also added
  `enableHardwareTrigger`/`disableHardwareTrigger`, both routed through
  `lease.reconfigure()` per §6 so the shared preview loop restarts cleanly.
  **Not verified against real hardware — and can't be yet**: the
  `triggerSource`/`lineSelector` GenICam names (`"Line0"`/`"Line1"`
  defaults) are placeholders, explicitly documented as such in the code;
  confirm against `lease.camera.trigger_source_options` (and the FLIR
  datasheet/GenICam node map) during the eventual bench pass before relying
  on them.
- **Not done**: no live run of any of this (no hardware in this
  environment); the orchestrator thread's session unit-test harness
  (orchestrator.md §7.1 item 2) that would exercise `createStream`/`frame`
  against a fake `Device` did not exist at the time of writing this — `sync.
  ts`'s pure-function design (no `Device` dependency in the matching math)
  sidesteps needing it for that half, but `controller.ts`'s new methods
  themselves are untested beyond `vue-tsc` type-checking.

**Next for this thread:** hardware-gated from here — bench verification
(§4) → flash v2 → live-verify P4 (real trigger line config, real
calibration) → P5, per §7. No further code-only work identified; check back
here for new planner findings before starting anything not listed above.

### 9.6 P3.1d Frame timestamp plumbing — [coder] 2026-07-04

- **`core/lib/Aravis/Frame.h` + `core/src/Frame.cpp`**: `Frame` now stores
  both Aravis timestamps at construction: `deviceTimestamp`/`device_timestamp`
  from `arv_buffer_get_timestamp()` and `systemTimestamp`/`system_timestamp`
  from `arv_buffer_get_system_timestamp()`. Existing `timestamp` remains a
  back-compat alias for the device timestamp.
- **`core/dist/Aravis/index.d.ts`**: declares the explicit timestamp fields;
  this is additive and does not change existing `Frame.timestamp` consumers.
- **`app/lib/orchestrator/protocol.ts` + `app/orchestrator/registry.ts`**:
  `FrameMeta` can carry `deviceTimestamp` and `systemTimestamp`; the registry
  copies them out before `frame.release()`, preserving the CoreObject rule
  that released frames must not be touched.
- **`app/orchestrator/sync.ts`**: comments now reflect the landed
  `Frame.deviceTimestamp` adapter while keeping the matching math typed
  against `DeviceTimestamped` for synthetic tests.

**Remaining sequence:** no further code-only prerequisite is known *in this
plan*. **Stage 2 assignments (planner, 2026-07-04 — full specs in
orchestrator.md §7.1):** this thread takes **S2** (make store-hub the sole
store owner — reroute `orchestrator/{calibration,camera}.ts` off the raw
`store.ts` primitives, then make `store.ts` private to the hub) and **S3**
(recorder worker thread — `stream-writer.ts` into a `worker_threads`
worker fed by transferred `ArrayBuffer`s; no `core` in the worker;
measure the win via `loopLag` during recording), plus the **64-stream
bump (user-approved 2026-07-04**; estimate under §8 open question 2).
**Queue order changed 2026-07-04: P4.1 (§9.7.2 — FIN delivery fix +
serial trace) goes FIRST** — it blocks every FIN-awaiting path; S2/S3/
ST-64 follow. Items:
- **ST-64a** — `Streams::CAPACITY` 8 → 64 (+ ~1.3 kB static RAM), host
  allocator range 0..63 in `controller.ts`, harness tests for allocator
  exhaustion + id reuse after `close()`. `QUEUE_CAPACITY` stays 8
  (deepening/fairness is conditional Tier 2, pending Stage F data).
- **ST-64b** — firmware serial intake chunk-drain: `loop()` drains
  `Serial.available()` per iteration instead of one byte (removes the
  ~1 MB/s intake ceiling; worst case 64 × 1 kHz ≈ 1.5 MB/s). **Must land
  before Stage F** — the bench must baseline the real intake path;
  retrofitting later invalidates the serial-throughput numbers.
- **ST-64c** — host update policy in `StreamHandle.update()`:
  update-on-change (skip identical targets) + per-stream minimum
  interval (~1 ms default), so serial load scales with control activity,
  not stream count. Harness-testable.
Also one small core item added 2026-07-04: **`Device.stats` serial counters**
(`{txBytes, rxBytes, txPackets, rxPackets}` cumulative, bumped in
`send`/`rxLoop`, exposed as a getter + `.d.ts`) — feeds the S4 profiler's
serial-data-rate probe (spec in orchestrator.md §7.1 S4 added-scope; the
telemetry/UI half belongs to the profiler work, not this thread). After
those: Stages F–H of
[`verification-playbook.md`](./verification-playbook.md) (bench → flash →
live P4 → P5), prepared in advance.

### 9.7 P4.1 — FIN delivery on hardware: finding, hardening, trace (compacted; full forensic history in git)

**Symptom (hardware smoke, 2026-07-04):** v2 firmware + rebuilt host —
version handshake, enable, and CMD_STREAM smoke all pass; but two-phase
`CMD_ACTUATE` times out at the JS FIN await even though the native rx loop
logs both ACK and FIN arriving (~same instant, settle_time≈0) and the
dispatcher drains its tasks without any error lines (log captured
stdout+stderr).

**Planner diagnosis eliminated, in order:** rx dispatch bugs (pr copied,
entry kept across ACK, retired on FIN — read clean); swallowed task
exceptions (no ERROR lines with aggregated output); promise-identity on
the clean path (`napi_deferred` is persistent); microtask-checkpoint
absence as *sole* cause (the test's own 102/500 ms timers force
checkpoints). Two latent defects were found regardless and fixed; root
cause remains **undetermined until the next bench run**, which the trace
below is designed to make decisive.

**P4.1 code-side pass — [coder] 2026-07-04, ✓ planner-verified (round 4):**
- `ResolveAck`/`ResolveFin` exception-safe: decode+Resolve in try/catch,
  settled flag **after** success, `Reject(decodeError)` on failure (the old
  flag-before-throw disarmed the destructor's timeout fallback →
  permanent silent pend; that class is dead now).
- Dispatcher owns a `Napi::AsyncContext`; every drain wrapped in
  `Napi::CallbackScope` (microtask checkpoint after resolves — also
  un-skews all bench latency numbers).
- **Full serial lifecycle trace landed** (17 trace points, all `seq=`-
  greppable, behind log level): `tx` (with two_phase+v2_capable at
  decision time), `rx … matched/retire/pending[…]` (closes the
  recv-vs-matched gap), `task … branch/two_phase/payload/first8`,
  `resolve … ok|FAILED`, `drop … unsettled=…` on destructor rejection,
  `drain n/remaining`.
- `Device.stats` `{txBytes,rxBytes,txPackets,rxPackets}` landed (+`.d.ts`)
  — also unblocks the S4 profiler serial-rate probe.
- Test hardened: `.accepted` now mandatory under v2 (fails fast if the
  property is lost), race outcomes labeled by which promise actually
  settled (winner identity, not timing inference), stuck-native timeout.
- Verified: `core make build` clean both runtimes; test file passes tsc +
  Node type-strip constraints.

**Acceptance (next bench run):** one failing `CMD_ACTUATE seq=N` must show
a complete lifeline `tx → rx×2(matched=1) → task×2 → resolve×2 ok` or an
explicit broken link. If FIN still times out *after* `resolve … ok`:
minimal N-API Deferred/async-context repro is the next step. Trace log =
the finding's artifact (playbook Stage F clause).

### 9.8 Final code round — [coder] 2026-07-04

- **S2 store sole-owner:** `app/orchestrator/{camera,calibration}.ts` now
  read through `store-hub`; `store.ts` is documented as hub-private. Boundary
  check: only `store-hub.ts` imports raw `store.ts`.
- **S3 recorder worker:** `stream-writer.ts` now writes in a
  `worker_threads` worker fed by transferred `ArrayBuffer`s; worker imports
  no `core`; `.stream`/`.meta` format preserved. Harness:
  `stream-writer.test.ts` covers output + queue overflow.
- **ST-64a:** firmware `Streams::CAPACITY` 8→64; host allocator range 0..63
  via `StreamIdPool`. Harness: allocator exhaustion and id reuse.
- **ST-64b:** firmware `loop()` drains `Serial.available()` each tick instead
  of one byte, removing the planned serial intake ceiling before Stage F.
- **ST-64c:** `StreamHandle.update()` now skips unchanged targets and enforces
  a 1 ms per-stream minimum interval via `StreamUpdateGate`. Harness covers
  identical-target skip and interval gating.
- **Verification:** `app npm test -- --run` 49/49; `core make build` both
  runtimes; `firmware make build` passed (rerun escalated for PlatformIO
  `~/.platformio` lock/cache). `app npm run build` got through `vue-tsc` and
  all Vite builds; final packaging failed because `electron-builder` is not
  installed in this workspace. Orchestrator bundle scan found no Vue import
  leakage.

### 9.9 Stage 3 Round 1 — T3/T4 multi-fovea dry run [coder] 2026-07-05

- **T3 scheduler:** added `app/orchestrator/scheduler.ts`,
  `RoundRobinFrameScheduler` over `Controller.frame()` with ≤8 in-flight
  clamp, fair rotation, duplicate-REJ tolerance, FIN/ACK timeouts → requeue,
  and per-stream pacing. Harness: `app/test/scheduler.test.ts`.
- **T4 multi-fovea skeleton:** added `modules/multi-fovea/` contract,
  runtime, session, and renderer. Session drives M center-frame trackers
  sequentially, creates one v2 stream per enabled target when `v2Capable`,
  feeds scheduler target ids, and publishes per-target telemetry.
- **Capture gate:** `captureOnce` returns structured REJ reasons
  (`controller-not-connected`, `controller-not-v2-capable`,
  `stage-f-hardware-gated`); no fake live synced capture is exposed.
- **Registration:** app menu now opens Object Tracking (Multi);
  orchestrator registers the `multi-fovea` session.
- **Verification:** focused scheduler/runtime harness 5/5; full app Vitest
  54/54; `vue-tsc --noEmit` clean; `vite build` clean.

### 9.10 Stage 3 Round 2 — T6 async tracker updates [coder] 2026-07-05

- **Core API:** `core/Tracker.KCF` gained `updateAsync(frame)` via
  `AsyncTask`; synchronous `update()` is unchanged. `.d.ts` updated.
- **Safety:** `updateAsync` captures the `cv::Ptr<TrackerKCF>` and converts
  the JS `Mat` synchronously before queueing; each call pays one full Mat
  copy before the worker thread, then no worker touches JS wrappers.
- **Multi-fovea:** runtime now launches enabled target updates with
  `Promise.all` and drops overlapping center ticks while a batch is in
  flight, avoiding reentrant KCF updates on the same native tracker.
- **Lifecycle:** runtime generation tokens ignore late async completions
  after target changes or `dispose()`; harness covers dispose while an
  update is pending.
- **Verification:** `core make build` clean for Node/Electron; app Vitest
  55/55; `vue-tsc --noEmit` clean; `vite build` clean; renderer remains
  zero-core and orchestrator remains zero-Vue by bundle grep.

**Planner ✓ (2026-07-05), all gates re-run independently.** The two
claims that had to be true both hold in code: `convert<cv::Mat>`
(`core/src/OpenCV.cpp:259`) `memcpy`s into a fresh Mat before the worker
is queued (worker never touches JS-owned/reused buffers), and the task
lambda captures the refcounted `cv::Ptr<TrackerKCF>` by value (a JS-side
`release()` mid-flight can't free the native tracker under the worker).
One over-scope was caught in review: the original "generation tokens
ignore late completions" claim covered `updateAsync` only. Round 3 T8
extends the same lifecycle discipline to `syncStreams()` stream creation;
harnesses now cover post-dispose completion and target changes during an
in-flight sync.
