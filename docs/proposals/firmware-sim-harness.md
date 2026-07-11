# Firmware-in-the-loop simulator — real firmware logic on the host

Status: **SHIPPED (2026-07-11; Mac build pass owed).**

## AS SHIPPED (2026-07-11)

Landed as ruled: `test/fw-sim/` (Arduino/SPI HAL shim + pty pump mirroring
`Firmware.cpp`'s loop verbatim, scriptable strobe injection, `--loop-us`
saturation knob), `test/fw-sim-check.cpp` (core-free wire self-check, all 8
sections), `core/test/47-firmware-sim.ts` (Device-driven, all 9 sections —
including the v2.0.0 `settle_time` deferral's first behavioral test
anywhere, exposure-averaged FIN positions pinned with a mid-exposure UPDATE,
and the full Enable(false) teardown wire-order). ONE `#ifdef FOVEA_HOST_SIM`
guard in `firmware/src/Protocol.cpp` (the ARM `bkpt` reset instruction —
cannot assemble on a host; `#else` branch byte-identical); `lib/` untouched;
MEMS.cpp compiled as the fifth real TU so the DAC-train assertions exercise
the real enable sequence. Exceptions ON host-side (crash.h throws, matching
core).

**Immediate payoff — two real core bugs on its first run** (fixed in
`b5b1f30`): the wave-6 rx-thread self-deadlock on pending retire (would have
broken the rig connect sequence outright), and CMD_TRIGGER registered as
uint16 since inception against a uint32 wire field (never worked through the
NAPI factory). Report-only firmware observation: `cancelPendingTrigger()` at
Enable(false) REJs without lowering a raised trigger pin (visible in the
sim's pin log).

RIG/MAC-GATED: `cd test && make build` + `fw-sim-check` green on macOS
(openpty/`_NSGetExecutablePath` paths guarded but unverified here);
firmware `.hex` byte-identity via `pio run` diff; sim-vs-rig fidelity
numbers (strobe latency, STROBE_MARGIN_US, settle t_trigger deltas from
real FINs).

## Problem

The numbered core tests talk to a scripted pty peer: packet LAYOUT agreement
is verified (shared `lib/Protocol` + static_asserts on both ends), but no
firmware BEHAVIOR ever executes off the rig — the dispatch switch, the
64-slot stream table, the capture engine, settle-gate timing, REJ paths.
The protocol ships as a matched set, flashing is rig-gated, and there is no
CI: protocol logic changes (e.g. v2.0.0's `settle_time`, which has never
run anywhere) get zero pre-flash regression coverage.

## Design

**A host binary compiling the REAL firmware translation units** —
`firmware/src/{Protocol,Streams,Capture,Global}.cpp` (NOT `Firmware.cpp`,
whose `setup()/loop()` the sim replaces with its own pump) plus the shared
`lib/` — against a thin HAL shim:

- `test/fw-sim/` (the host `test/` CMake tree already compiles `lib/**`):
  shim headers satisfying the firmware's includes — `micros()` from the
  steady clock, `noInterrupts()/interrupts()` as a recursive-mutex pair,
  `Board.h`-compatible pin objects that RECORD writes (trigger/enable/LPF),
  a MEMS-SPI capture that logs DAC words, and scriptable STROBE-EDGE
  injection (rise/fall schedules relative to the trigger write, per camera,
  with configurable latency/jitter) driven from a control channel.
- The `fovea-fw-sim` binary owns a pty pair (prints the slave path on
  stdout), and its main loop mirrors `Firmware.cpp`'s exactly:
  `time.update → Streams::tick → Capture::tick → Protocol::tick → drain
  COBS rx → handle()`. A `--loop-us` knob throttles the service rate to
  emulate device-side saturation (the wave-6 governor's future sparring
  partner).
- **Zero edits to `firmware/src/` and `lib/`** is the target; if a seam is
  truly impossible to shim around, a minimal `#ifdef FOVEA_HOST_SIM` guard
  is acceptable — each one logged in the report. `firmware/` PlatformIO
  builds must remain byte-identical.

**Driving test** — `core/test/47-firmware-sim.ts`: core's `Device` against
the sim over the pty, exercising real firmware behavior for the first time
off-rig:

- `verifyVersion` (v2.0.0 handshake), Enable sequence + DAC bias writes
  recorded, `Config::Bias` REJ while enabled.
- Stream table: CREATE/activate, fire-and-forget UPDATE (seq=0 silence),
  TERMINATE, TERMINATE-with-pending-frame REJ.
- CMD_FRAME two-phase: ACK{queue_position} → injected strobes → FIN with
  frame_id + exposure-averaged mirror positions (rise/fall latch mean);
  strobe-timeout REJ; queue-full (8-deep) REJ; duplicate-pending REJ.
- **`settle_time` deferral on a stream SWITCH** (trigger delayed by the
  settle window, same-stream frames undeferred, `settle_time: 0` parity) —
  the v2.0.0 feature's first behavioral test.
- One-Actuate/one-Trigger-in-flight REJ; `Enable(false)` teardown order
  (capture cancel → streams clear → pending cancels → MEMS disable).

## Sequencing / ownership

Parallel lane (worker 2): owns `test/fw-sim/**`, the `test/` CMake
additions, and the NEW `core/test/47` only — no edits to `core/src`,
existing tests, or `app/` (wave 6 concurrently owns Serial/Controller).
Integrating the sim as the peer for tests 45/46 (replacing scripted mocks)
is a LATER wave, after both this and wave 6 land.

## Verification

- `cd test && make build` builds the sim on Linux (and must be
  macOS-compatible: openpty differences guarded like `utils/thread.h`).
- `node core/test/47-firmware-sim.ts` green; all existing suites untouched
  and green; firmware PlatformIO tree untouched (`git status` clean there).
- RIG-GATED: none directly — the sim's fidelity is validated the first time
  rig behavior disagrees with it; discrepancies get logged as sim bugs or
  real firmware findings.
