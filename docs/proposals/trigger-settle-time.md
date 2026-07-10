# Trigger settle time (protocol v2.0)

Status: CODE-COMPLETE 2026-07-10, rig-gated (firmware flash + core rebuild owed).

## Motivation

The multi-fovea round-robin interleaves N streams by issuing `CMD_FRAME`
requests across them. Each request that targets a *different* stream than the
last commands the MEMS mirror to a new location, then immediately asserts the
camera trigger. On the rig the mirror needs a few ms to physically reach the
new target; triggering before it settles smears the first frame after every
switch. This adds a per-switch **settle hold**: after a stream switch the
firmware moves the mirror, waits `settle_time`, then runs the normal exposure.

## Semantics (ruled)

- `settle_time` is in **microseconds** (µs), matching the existing
  `CMD_ACTUATE.settle_time` precedent.
- The hold is applied **only on a stream SWITCH** — the popped `CMD_FRAME`'s
  stream differs from the currently-active DAC stream (the first request after
  `INVALID_ID` counts as a switch). Consecutive frames on the *same* stream get
  no hold, exactly as before.
- Settle is **independent of exposure**: it delays the trigger *assertion* only.
  `pulse` (exposure/trigger width) and the strobe/timeout machinery all start
  from the real trigger edge — settle is never subtracted from exposure.
- `settle_time == 0` (the default) reproduces the pre-v2.0 behavior
  byte-for-byte on the wire and in timing.

## Protocol field placement

Extends the **`CMD_FRAME` request payload** (`Packet::Command::Frame`), the
payload the round-robin already builds per request, with a trailing
`Microseconds settle_time`:

```
FIXED_SIZE_PACKET(Frame, CMD_FRAME) {
  uint8_t stream;
  uint8_t cameras;
  Microseconds pulse;
  Microseconds settle_time;   // v2.0 — held only on a stream SWITCH
};
static_assert(sizeof(Frame) == 10, ...);
```

### Version bump — v1.1.0 → **v2.0.0** (breaking)

`FixedSizePacket::inflate` is **exact-size** (`dataSize() != sizeof(Payload)`
CRASHes). Growing `Frame` from 6→10 bytes changes an existing payload's length,
so — unlike the additive v1.1 `SYS_TIMESTAMP` property — this is a **breaking**
wire change. Firmware, core, and host must ship as a **matched set** for v2.0.
`verifyVersion()` gates `v2Capable` on `firmware.major >= Version::Major`, so a
v2 core paired with old (major-1) firmware simply disables CMD_STREAM/CMD_FRAME
(safe, no crash); a matched v2 pair is required for the field to transmit.

## Firmware (where the switch-detection hook lives)

`firmware/src/Capture.cpp` `startNext()` — the point a queued request becomes
active. It reads `Streams::active()` **before** `Streams::activate(...)`; a
change is a switch. On a switch with `settle_time > 0` it commits the mirror
(`Streams::activate` + `Streams::tick`) but **defers** the trigger, setting
`awaitingSettle`/`triggerDueAt`. `tick()` gains a settle gate ahead of the
exposure logic: while `awaitingSettle` it holds off every strobe/pulse/timeout
step and asserts the trigger once `now >= triggerDueAt`, after which the request
proceeds identically to the no-settle path. `finishActive`/`cancelAll` clear the
flag so a hold never leaks across requests.

## App-side

- `app/orchestrator/controller.ts` `frame()` — accepts `settle_time?` and passes
  it through to the native `Protocol.Command.Frame` encoder.
- `core/src/Controller.cpp` `FramePacket` — reads + echoes `settle_time` (the
  ONE core-C++ touch this feature needs; mirrors the existing `ActuatePacket`).
  Without it the grown firmware struct would CRASH `inflate` on the old 6-byte
  payload — the field cannot be app-TS-only.
- `app/orchestrator/scheduler.ts` — `FrameRequest.settle_time` threaded through
  `issue()`.
- `app/modules/multi-fovea/session.ts` — the scheduler's `requester.frame` fills
  `settle_time` from `state.settle_time_us` on every CMD_FRAME.

## Per-triple config

Follows the `zoom_override` / `baseline_mm` per-triple pattern exactly:

- Key: **`settle_time_us`** on the `["triples", <hash>]` doc
  (`app/lib/calibration-data.ts` `TripleConfig`), stored in µs.
- `orchestrator/calibration.ts` resolves it into `CalibratedTriple.settleTimeUs`
  (0 is a *meaningful* value — no hold — so it resolves to a number, not null
  like the >0-gated zoom/baseline).
- The multi-fovea session **seeds** `state.settle_time_us` from the active
  triple at activation; the drawer slider overrides it **live** for the running
  session. Settings-page edits persist to the per-triple doc and are picked up
  at the **next** session start — config-store docs are per-instance, so a live
  cross-instance push is intentionally out of scope (documented in code).

## UI

- **Multi-fovea drawer** (`app/modules/multi-fovea/index.vue`): a Settle slider
  (0–20 ms, 0.1 ms step) bound to `state.settle_time_us`, applying live; plus
  numeric pan/tilt editors for the demo preset locations.
- **Triple settings** (`app/src/windows/ConfigBody.vue`): a Settle-time field
  (ms, 0 = none) in the per-triple expandable, same interaction as zoom/baseline.

## Demo configuration (part 1)

Multi-fovea opens with two **angle-space preset** foveas (mirror degrees):
loc 1 = (−5°, −5°), loc 2 = (+5°, +5°), interleaved by the existing round-robin.
Presets are static (no KCF); the mirror parks at each angle via the EXISTING
per-eye `A2V` mapping (both eyes at the same angle — vergence at infinity), and
the fovea crop is placed at the projected wide pixel (`A2P.C`). Editable in the
drawer; `Reset` returns to the ±5° pair.

## AS-SHIPPED notes / open

- Core rebuild + firmware flash owed (rig-gated) — the running dev binary
  ignores the extra `settle_time` object key harmlessly until then.
- Preset targets feed the SAME angle to both eyes (infinity vergence) — matches
  the drag-follow parallel ruling. If per-eye preset vergence is ever wanted it
  would be a new field.
