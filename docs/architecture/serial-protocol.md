# MEMS controller serial protocol

> Source of truth: `app/orchestrator/controller.ts` (host-side `Controller`),
> `core/Controller` (native `Device` + `Protocol`), `firmware/` (MCU),
> `app/orchestrator/scheduler.ts` + `sync.ts` (synced capture),
> `app/orchestrator/controller-node.ts` (the position-stream push model).
> Full protocol design history: `docs/history/refactor/synced-capture.md`.

## 1. Device model

The orchestrator's `controller` session owns the serial `Device`
(`core/Controller`); other sessions actuate the SAME device via the
module-level `activeController()` holder. Connection setup runs
`verifyVersion()` first — old firmware keeps `v2Capable` false and every v2
surface hard-requires it (v1 compatibility never throws on a version
mismatch, only on transport failure).

Every serial write is metered (`controller:<port>` → `packets`,
`metering.md` §4).

## 2. v1 surface

Request/ACK commands: `Enable`, config (`Bias`/`LPF`/`Log`), `Actuate`
(4-channel DAC vector per mirror; the ACK echoes the actuated channels,
decoded back to volts via `dac2volt`), `Trigger`.

## 3. v2 surface — streams and synced frames

- **CMD_STREAM** — a named, continuously-updatable mirror-position target
  (64 slots, `Streams::CAPACITY`). CREATE/TERMINATE are ACK-backed;
  **UPDATE is fire-and-forget** (seq=0, no response, ~kHz-safe). Host-side
  `StreamHandle.update()` suppresses identical targets and enforces a 1 ms
  min interval.
- **CMD_FRAME** — a triggered capture request on a stream. Two-phase:
  `.accepted` resolves on ACK (queue position; rejects on REJ), the request
  itself resolves on **FIN** carrying `frame_id`, MCU trigger/exposure
  timestamps, and the **exposure-AVERAGED mirror voltage** (sampled at
  exposure start AND finish) — the authoritative frame↔voltage binding the
  recorder stores (`recorder.md` §1). `sync.ts` pairs L/R FINs by timestamp.
- **FW5 (firmware constraint):** never mix awaited `Actuate` writes with an
  active stream — `Streams::snapshot()` would report the stream target
  rather than the DAC's actual state. A control loop owns its stream
  exclusively while running.

## 4. The actuation path (controller node, push model)

The old per-session `startActuationLoop` (1 ms pull loop, `actuation.ts`)
is **deleted**. Its role is absorbed by the singleton **controller node**
(`app/orchestrator/controller-node.ts`): each hot-actuating session calls
`node.openPosition(name, { from, initial })` and PUSHES target poses at its
own natural cadence (kernel result / pointer / servo tick). On v2 firmware
each open position input maps 1:1 to a CMD_STREAM (created on first update,
`StreamUpdateGate`-dedup'd fire-and-forget `update()` per push — no awaited
round-trip caps the rate — publishing **locally predicted** volts via
`Controller.predictVolts(pos)`, the exact `channels()`→`dac2volt` math the
Actuate ACK would echo; the MCU stream holds position between pushes). On v1
it runs one internal paced awaited `actuate()` loop over the latest pushed
pose. Enable lifecycle: enable on first open if disabled, disable on last
close iff the node enabled it; streams drop + lazily recreate on controller
reconnect. `update()` also records the predicted trajectory into
mirror-history (the single trusted-time writer). RIG-VERIFY items for this
path live in `docs/hardware/stage-f.md` (prediction accuracy vs a sampled
readback; FW5 coexistence with CMD_FRAME).

## 5. Hardware triggering

Only the L/R cameras are hardware-triggerable on the current rig — the
center camera's GPIO port is reserved on the board but uncabled
(camera-side connector size; recoverable with a slimmer cable —
`docs/hardware/rig.md`).

*(Planner-review stub: wire-level framing — packet layout, seq/ACK/REJ/FIN
encoding, CRC — is B/firmware-owned; transcribe from `core/src/
Controller.cpp` + `firmware/include/` when pinning this section.)*
