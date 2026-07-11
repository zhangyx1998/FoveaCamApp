# Serial rate governor — maximum sync rate without jamming or overload

Status: **PROPOSED (ruled 2026-07-10).** Builds on
[`native-compose-controller.md`](./native-compose-controller.md) (wave 5 —
the native controller `pos_in` gate is where the governor lives); sequenced
after it.

## User ruling (2026-07-10)

Push the mirror-stream sync rate **as high as possible** subject to two
constraints: (1) never jam other packets on the link (two-phase ACK'd
requests, CMD_FRAME, pings must not queue behind UPDATE floods); (2) never
overload the link or the device itself.

## Why a closed loop (not a bigger constant)

The Teensy 4.0 link is USB 2.0 HS (480 Mbps) — raw bandwidth is not the
limit. The binding constraints are the firmware's `loop()` service rate
(COBS pump + per-packet handle between `Streams::tick`/`Capture::tick`
work) and queueing ahead of it. Neither is knowable at build time (varies
with capture activity, host load, cable/hub), so the rate must be
DISCOVERED and TRACKED, not configured.

## Part 1 — pressure instrumentation (host-side, no firmware change)

Extend `Device.stats` (core Serial/Controller):

- `outqBytes` gauge + `outqHighWater` — `ioctl(TIOCOUTQ)` polled at the
  stats cadence: bytes in the kernel tty output queue (where CDC-ACM NAK
  backpressure materializes).
- `txSoftFail` — count of `EAGAIN`/short-write events on the O_NONBLOCK fd
  (each is a discrete overflow event; audit that the write loop already
  re-frames correctly on short writes — a silent truncation would corrupt
  COBS framing).
- `ackRttMs` rolling stats (p50/p95/max over the trailing window) — derived
  from existing two-phase request→ACK timing; queue pressure inflates RTT
  before anything drops. Fire-and-forget UPDATEs are deliberately
  unmeasurable — their pressure is only visible via outq + RTT of others.
- A low-rate PROBE ping (~2 Hz `SYS_TIMESTAMP` GET, reusing the clock-ping
  machinery) so `ackRttMs` stays live even when no user traffic flows —
  this is the device-loop-saturation proxy.

## Part 2 — the governor (native, in the wave-5 `pos_in` gate)

AIMD control of the UPDATE emission interval, evaluated at the stats
cadence (~100 ms — control loop is orders slower than emission, stable):

- **Additive increase**: while `outqHighWater` stays under the LOW
  watermark AND `ackRttMs.p95` is within `rttInflationFactor` (default 2×)
  of its baseline (median of the first seconds after connect), raise the
  effective rate by `stepHz` (default 25 Hz) toward the ceiling.
- **Multiplicative decrease**: on any `txSoftFail`, outq above the HIGH
  watermark, or p95 RTT beyond the inflation gate → halve the effective
  rate (floor 60 Hz), then re-probe upward.
- **Ceiling** = `prediction_rate_hz` (the existing global setting keeps its
  meaning as the REQUESTED rate; "as high as possible" = set the slider
  high and let the governor find the sustainable point). The imm brick
  keeps predicting at the ceiling; the gate coalesces latest-wins down to
  the effective rate — freshest-sample semantics are preserved.
- **Fairness reserve**: while a two-phase request is pending older than
  `fairnessMs` (default 5 ms), UPDATEs are deferred (coalesced, not
  queued) until its ACK arrives or the deadline passes — requests never sit
  behind a stream burst. Watermarks are chosen so worst-case added latency
  for a request behind the queue is ~1 ms of serialized bytes.
- All knobs live in one `GovernorParams` struct (NAPI-settable, defaults
  baked); OFF switch (`governor: false`) pins the old fixed-gate behavior.

## Part 3 — surfacing

- **Every new stat surfaces in the profiler** (user ruling, 2026-07-10):
  `effectiveRateHz` vs requested, governor state (`seeking | steady |
  backoff`), `outqBytes`/`outqHighWater`, `txSoftFail`, and the `ackRttMs`
  p50/p95/max join the controller session telemetry and render in the
  profiler's **Control tab** as a "Serial pressure" block beside the
  existing Serial data rate section (same 1 Hz snapshot cadence; rolling
  windows follow the `stats.ts` `SampleStats` idiom).
- The stage-f "Serial rate" checkbox gains: record the discovered
  steady-state rate on the real rig for both the JS-driven (manual-control)
  and native-driven (disparity-scope) paths.

## Part 4 — serial-latency compensation in the motion predictor (ruling addendum, 2026-07-10)

The per-triple `delay_compensation_ms` is a FIXED lookahead that empirically
absorbs the whole tracking-chain latency. The serial hop's contribution
varies (queue depth, host load) — with Part 1's sensors it becomes adaptive:

- **Estimate**: `serialLatencyMs = EMA(ackRttMs.p50) / 2` (one-way ≈ half
  the ACK round trip; EMA smoothing so RTT jitter never whips the
  predictor). Refinement hook (rig-tunable, default off): add the queue
  drain term `outqBytes / lineRate` when the governor reports pressure.
- **Application**: the owning session (disparity-scope) polls the estimate
  at the existing stats throttle and pushes
  `imm.setParams({ delayMs: fixed + (enabled ? serialLatencyMs : 0) })` —
  reuses the live-retune path, no new native plumbing; the predictor's
  propagation Δ simply gains a measured term alongside the fixed one.
- **Config**: a GLOBAL app-config **on/off switch** (`serial_latency_comp`,
  default **off**), surfaced in Settings → Global config next to the
  prediction-rate control (no drawer control — Settings only, per ruling).
  When off (or no controller / no RTT samples yet), behavior is exactly the
  fixed lookahead.
- **Telemetry**: the applied total lookahead (fixed + live) joins the
  controller/serial-pressure telemetry so the profiler shows what the
  predictor is actually leading by.

## Explicitly out of scope

- Firmware-side RX high-water/drop counters (needs a protocol rev + flash —
  future v2.x; the ACK-RTT proxy covers the gap meanwhile).
- Any change to two-phase or CMD_FRAME semantics.

## Verification (software; fake-serial)

- New numbered core test (`46-rate-governor`): scripted fake-serial that
  injects EAGAIN bursts, synthetic outq readings, and RTT inflation —
  assert additive climb to ceiling on a clean link, multiplicative backoff
  + re-probe on each pressure signal, fairness deferral (a pending request
  always ACKs within the deadline under full-rate flood), floor/ceiling
  clamps, OFF switch parity with wave-5 behavior.
- `45/44/42` stay green; vitest for the telemetry plumbing; vue-tsc; d.ts.
- RIG-GATED: discovered steady-state rate on real hardware (record in
  stage-f), no CMD_FRAME/ping starvation during capture under full-rate
  streaming, governor backoff visibly triggering on a deliberately loaded
  bus.
