# Prediction compose node — native IMM brick + high-rate mirror stream

Status: **PROPOSED (ruled 2026-07-10; supersedes the inline IMM wiring of
[`imm-delay-compensation.md`](./imm-delay-compensation.md) — the filter math,
sign convention, and per-triple `delay_compensation_ms` key all remain).**

## Problem (user-reported, 2026-07-10)

1. The IMM motion-predictor node does not show up on the profiler node graph.
   Root cause: it is only constructed when `delay_compensation_ms ≠ 0` (delay
   0 → "inert, not wired at all"), and even when wired it is a synchronous
   per-tracker-result transform — not a standalone producer with its own
   thread and rate.
2. The topology is wrong: the `disparity-scope/pid` node should produce
   control signals at camera framerate (~60 fps), and a SEPARATE node should
   compose those ~60 Hz control signals with high-rate predicted motion,
   yielding a high-rate (default **600 Hz**) update stream to the mirror
   position input.

## User rulings (2026-07-10)

1. **Compose math — feed-forward delta in volt space.** Hold the latest pid
   output `V_pid` (absolute volts, computed from the measurement at frame
   time `t_pid`) as the baseline. Each prediction tick:
   `V(t) = V_pid + J·(p_pred(t) − p_meas(t_pid))`, where `J` is the
   pixel→volt sensitivity at the current operating point (via the triple's
   coordinate conversions). Every new pid result REBASES the baseline. The pid
   node's semantics/timing are untouched.
2. **Rate is a GLOBAL app setting** (not per-triple): one key, default
   **600 Hz**, edited from BOTH Settings → Global config AND a slider in the
   disparity-scope drawer (same store key; live-applies). Suggested key:
   `prediction_rate_hz`, clamped 60–1000.
3. **The prediction loop is a NATIVE C++ brick** — its own free-running
   thread, ThreadMeter instrumentation, Topology row; the TypeScript
   `ImmPredictor` stays as the REFERENCE implementation with shared
   conformance fixtures (the `docs/schema/codec/12p-vectors.json` precedent).
4. The per-triple `delay_compensation_ms` remains the prediction OFFSET
   (signed, brick param). Delay 0 no longer unwires anything — the brick is
   ALWAYS wired while disparity-scope tracking is active, so the node is
   always visible in the profiler graph (fixes problem 1).

## Target topology

```
kcf ──(measurements, ~60 Hz)──→ imm (native thread, rate_hz) ──→ compose ──→ controller
 └────(target, ~60 Hz)────────→ pid ────────────────────────────→ compose
```

- **pid consumes RAW tracker results** (not predicted ones — reverting the
  `kcf → imm → pid` chain). The feed-forward delta pairs `V_pid` with the
  measured center it acted on; a predicted pid input would double-count the
  motion.
- **compose** pushes `posInput.update()` once per prediction tick.
  `StreamUpdateGate` (1 ms min interval + dedupe) remains the serial guard;
  600 Hz sits inside it.

## Native brick (core lane)

- Port `app/lib/imm-predictor.ts` to C++ (same CP/CV/CA model set, defaults,
  joint gate, reset/passthrough/NaN-hygiene semantics — see
  `imm-delay-compensation.md` §Filter).
- Brick shape follows the tracker-brick pattern (`core/src/Tracker.cpp`): own
  thread, `ThreadMeter`, `Topology.report()` row, async-iterator output.
  NAPI surface (suggested `core/Tracker`): create with
  `{ rateHz, delayMs, …tuning }`; `ingest(result)` pushed from JS at tracker
  rate (measurement update); `setParams` for live rate/delay changes;
  `probe()`; release. (A direct native tracker→imm subscription is optional —
  only if trivially supported by the existing stream plumbing; otherwise the
  60 Hz JS ingest round-trip is negligible and keeps the seam testable.)
- Thread loop: propagate the combined estimate at the fixed period, emitting
  `{ center, bbox-delta or null, propagatedToNs, lastMeasurementSeq,
  coasting }`; predictions COAST through misses (covariance grows) — the JS
  side owns lost policy.
- TS↔C++ conformance: shared fixture vectors under `docs/schema/` consumed by
  BOTH a vitest suite (against the TS reference) and a numbered hardware-free
  `core/test/` script (against the brick with a synthetic measurement feed).
- Hand-update the relevant `core/dist/*/index.d.ts` (hand-written, never
  generated).

## Orchestrator / app (app lane)

- `app/modules/disparity-scope/session.ts`: always create the brick when
  tracking activates; feed it every tracker result; retire the inline
  `createImmNode` wiring (`app/orchestrator/imm-node.ts` path) — pid's
  `target` edge reverts to the kcf node.
- New graph-visible **compose node** (`app/orchestrator/` — e.g.
  `compose-node.ts`; pick a `kind` consistent with `graph-contract.ts` and
  teach the profiler renderer about it): `registerGraphWiring` +
  `registerWorkload` with truthful per-tick emit; inputs `pid` + `imm`,
  output → controller edge.
- Compose behavior: feed-forward ONLY while control is healthy — pid override
  engaged (drag) → pass the override volts through untouched; lost-gate
  active → hold `V_pid` baseline with no feed-forward; predictor reset on
  overridden results keeps its existing semantics.
- `J` (pixel→volt sensitivity): derive from the existing pure conversion
  helpers at the current pose; keep the delta math a pure, unit-tested
  function.
- Config plumbing: new GLOBAL key (`prediction_rate_hz`, default 600, clamp
  60–1000) — Settings → Global config control + disparity-scope drawer
  slider bound to the same store doc; session subscribes and live-applies via
  `setParams`.

## Non-goals

- No firmware/protocol change (v2 streams already take kHz fire-and-forget
  updates).
- No change to pid tuning, vergence math, or the tracker.
- No per-triple rate override (global only, per ruling).

## Verification (this machine is rig-less — software gates only)

- vitest: compose delta math, conformance vectors, session wiring (fake
  seams), config plumbing.
- `core make build` + numbered core/test script with synthetic measurements.
- vue-tsc, boundary greps (orchestrator Vue-free / renderer core-free),
  profiler graph shows `imm` + `compose` nodes with truthful edge rates.
- RIG-GATED (deferred to `docs/hardware/stage-f.md`): actual mirror-stream
  smoothness at 600 Hz, serial saturation headroom, feed-forward sign/scale
  on a real target.
