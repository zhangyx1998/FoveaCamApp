# serial protocol — firmware handler behavior

The wire format (COBS framing, packet header byte layout, Method/Property tables,
`Sequence` semantics) is the CONTRACT and lives at `lib/Protocol/Protocol.h` +
`lib/Protocol/Packet.h` — that is the authoritative source, not this file. This
spec records the FIRMWARE-side runtime behavior in `firmware/src/Protocol.cpp`
that isn't visible from the wire headers. Version history: `lib/Protocol/Version.h`.
The code carries `// spec:` pointers.

## fire-and-forget {#fire-and-forget}

`Sequence == 0` marks a fire-and-forget request: the firmware performs the action
but sends NO ACK/FIN/REJ. `Protocol::send()` short-circuits on `seq == 0` (only
applies to responses routed through that helper — LOG SYN pushes bypass it
entirely). Used by high-rate MirrorStream updates (~1kHz).

## two-phase actuate/trigger {#two-phase}

Protocol v2 §3.3. `Command::Actuate` and `Command::Trigger` are two-phase: an
immediate ACK, then a FIN after a timed delay, instead of blocking in
`delayMicroseconds()`. `Protocol::tick()` (called from `loop()` alongside
`Streams::tick()` / `Capture::tick()`) advances the completion timers and emits
the FIN when `now >= due`. Only ONE of each may be in-flight at a time — this
matches the pre-v2 blocking behavior (a second request couldn't arrive until the
first's delay elapsed); here the overlap is REJected instead of silently queued.
Callers wanting overlap use `CMD_STREAM`, which is what the refactor is for.

Pending actions are cancelled (REJected) on `System::Disable`.

## clock semantics {#clock}

The MCU clock (`Global::time`, wraparound-corrected uint64 µs) is the same clock
that stamps `FrameResult` `t_trigger` / `t_exposure`. Under the unified-time
ruling every clock mutation is EXPLICIT:

- `System::Enable` v1.1: enabling NO LONGER resets `Global::time`. An implicit
  reset here silently invalidated the host's controller clock calibration on every
  enable, breaking the "timestamps between nodes are always trusted" invariant.
- `System::Timestamp SET` is the ONLY clock reset (`Global::time.reset(payload)`,
  normally 0). After it, any host-side offset calibration is invalidated and must
  be re-run.
- `System::Timestamp GET` is the calibration ping (unified-time Ruling 4): it
  stamps the clock FIRST, at packet parse/handle time (`handle()` dispatches
  synchronously as the request leaves the COBS decoder), never at
  reply-serialization time, so the reading's jitter stays at the serial-latency
  floor.

## disable {#disable}

`System::Disable` does NOT let streams survive (resolved open question, synced-
capture §8.3). The MCU clock resets on the next enable, invalidating any host-side
clock-delta calibration anyway, so keeping stale stream targets buys nothing.
Disable cancels all in-flight/queued frame requests (`Capture::cancelAll`), clears
streams (`Streams::clear`), cancels pending actuate/trigger, powers down MEMS, and
drops the enable line.
