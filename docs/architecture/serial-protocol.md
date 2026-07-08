# MEMS controller serial protocol

> Source of truth: `app/orchestrator/controller.ts` (host-side `Controller`),
> `core/Controller` (native `Device` + `Protocol`), `firmware/` (MCU),
> `app/orchestrator/scheduler.ts` + `sync.ts` (synced capture),
> `app/orchestrator/actuation.ts` (the hot loop).
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

## 4. The actuation hot path

`startActuationLoop` (`actuation.ts`) is the single chokepoint every
hot-actuating session uses. On v2 firmware it opens one CMD_STREAM per run
and fire-and-forgets `update()` per tick — no awaited round-trip caps the
rate — publishing **locally predicted** volts
(`Controller.predictVolts(pos)`, the exact `channels()`→`dac2volt` math the
Actuate ACK would echo). On v1 it falls back to the awaited `actuate()` loop
unchanged. Stream lifecycle: open on start, close on stop, reopen on
controller reconnect. RIG-VERIFY items for this path live in
`docs/hardware/stage-f.md` (prediction accuracy vs a sampled readback; FW5
coexistence with CMD_FRAME).

## 5. Hardware triggering

Only the L/R cameras are hardware-triggerable on the current rig — the
center camera's GPIO port is reserved on the board but uncabled
(camera-side connector size; recoverable with a slimmer cable —
`docs/hardware/rig.md`).

*(Planner-review stub: wire-level framing — packet layout, seq/ACK/REJ/FIN
encoding, CRC — is B/firmware-owned; transcribe from `core/src/
Controller.cpp` + `firmware/include/` when pinning this section.)*
