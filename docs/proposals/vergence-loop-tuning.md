# Vergence loop tuning: PID auto-tune + tracker↔PID coupling

> STATUS: §1 IMPLEMENTED 2026-07-12 (spec
> [disparity-scope](../spec/disparity-scope.md#autotune)) — RIG-GATED,
> unverified on hardware until the owed rig pass. §2 R1 + R2 IMPLEMENTED
> 2026-07-12 (spec
> [disparity-scope](../spec/disparity-scope.md#capture-epoch-target));
> R3 (rig verification) OPEN. Companion to the 2026-07-12 kd-explosion fix
> (once-per-pair join gate + filtered derivative, spec
> [disparity-scope](../spec/disparity-scope.md#match-join)).

## 1. PID auto-tune (user request 2026-07-12)

The disparity-scope loop is a **9–12 dimensional** gain space (pan x/y, verge,
v_shift × kp/ki/kd) over a plant with ~2–4 frames of transport delay
(capture → slice → scale → match → step → compose → MEMS), quantized
measurements, and an IMM feed-forward path that changes the effective plant.
Established options, in increasing generality:

| Method | Shape | Fit here |
| --- | --- | --- |
| Relay auto-tune (Åström–Hägglund) | per-axis limit-cycle → ultimate gain/period → tabulated gains | GOOD first stage: the DOFs are constructed near-orthogonal, each has hard physical limits (`shiftLim`, verge range, `VSHIFT_LIMIT`) bounding the relay amplitude safely |
| Ziegler–Nichols / Tyreus-Luyben step response | per-axis open-loop step fit | weaker: our plant's delay-dominant response + noise fit the relay method better |
| Coordinate descent ("twiddle") | sequential 1-D search on a scalar cost | simple but slow in 9-D; every evaluation is a physical experiment |
| Nelder–Mead simplex | derivative-free joint search | noise-fragile without restarts |
| **CMA-ES** | population-based joint search, noise-tolerant | GOOD second stage: handles the cross-DOF terms relay misses (shared actuation, verge nonlinearity), robust to noisy costs, ~50–200 evaluations for 9-D |
| Bayesian optimization (GP) | sample-efficient global search | fewest experiments (~30–80), more implementation surface; SafeOpt variants add explicit safety constraints |

**Recommended: two-stage, session-driven.**

1. **Relay stage (per DOF):** an `autotune` command runs, per DOF, a small-
   amplitude relay experiment about the current pose (feed-forward OFF — the
   `composeHealthy` gate already expresses this; tracker disarmed; static
   target). Measure the limit cycle from existing telemetry (`pids` readout at
   the volt cadence), derive Ku/Tu, seed conservative (Tyreus-Luyben) gains.
   Runs in ~seconds per DOF, needs zero new instrumentation.
2. **Joint polish (CMA-ES):** scripted target steps (jump `state.target` by a
   fixed px offset — exactly what a drag does programmatically), cost =
   ITAE + overshoot penalty + actuation-effort term computed from the telemetry
   trace. CMA-ES over the full gain vector, seeded by stage 1, hard-bounded to
   ±1 decade around the seed. Budget-capped (e.g. 100 steps ≈ minutes on-rig).

Both stages are RIG experiments (real optics in the loop) — gate behind a
drawer action, never automatic. A simulation-only tune is possible against
`stepVergence` + a delay model, but it would miss the MEMS/optics dynamics that
dominate; use simulation only to smoke-test the optimizer itself.

::: details Implementation (2026-07-12) — behavior spec at [disparity-scope §autotune](../spec/disparity-scope.md#autotune); RIG-GATED, unverified until the rig pass
- **Pure core** (`app/modules/disparity-scope/`, each heavily unit-tested):
  `relay-tune.ts` (relay state machine: settle-reference, hysteresis relay,
  N-consistent-cycle detection, bounded amplitude escalation 2 % → ≤ 10 % of
  the DOF range, verdicts never throws, `tyreusLuyben`), `cma-es.ts` (minimal
  dependency-free (μ/μ_w, λ)-CMA-ES: ask/tell contract, box bounds, seeded
  xorshift RNG, log-space helpers), `step-cost.ts` (ITAE + quadratic
  overshoot + command total-variation, peak-normalized so the pipeline-delay
  lead-in is harmless), `autotune.ts` (the phase state machine over injected
  hooks — the session owns pose/gain application).
- **Session integration**: an `autotune` command (`{stage: "relay"|"full"}`)
  requires a calibrated triple + tracker disarmed, enters the manual-hold
  latch (feed-forward down), and `runControl` feeds a live run the SAME
  match-join projections; `autotuneAbort` restores the pre-tune tuning +
  pose. Time rides in loop-dt units (`elapsed-ms × sensitivity` captured at
  start), so relay Tu and the TL gains land directly in the loop's dt frame.
- **Optimizer smoke test** (`app/test/autotune-sim.test.ts`, NOT a rig
  claim): toy plant = first-order mirror lag behind a miscalibrated (0.85×)
  actuation gain, matched centers via a frontal scene plane, 3-tick transport
  delay, driven through the real `stepVergence`/`followTarget`. Combined sim
  step-cost: DEFAULT_TUNING 4.33 → relay-only 0.42 → relay + 24-eval CMA-ES
  polish 0.11; in-run eval baseline 2.32 → best 0.097. Deterministic per seed.
- The gain-mismatch plant matters: with a PERFECT actuation map the target
  step feeds through the reconstruction (`ray = aT + pan`) and gains barely
  move the cost — on the rig the residual the PID owns comes from exactly
  this calibration mismatch.
:::

## 2. Tracker↔PID coupling during follow (user request 2026-07-12)

Question: does the tracker's target update couple into and destabilize the PID
while following a moving target? **Yes — three distinct channels, one of them
also implicated in the kd explosion:**

1. **Setpoint/measurement epoch skew.** `onMatch` steps with `target:
   s.state.target` — the target as of NOW — while the matched centers `aL/aR`
   come from strips captured 2–4 frames AGO. While the target moves, the error
   `aT(now) − aL(t−Δ)` contains phantom error ∝ target velocity × Δ: the PID
   integrates motion it hasn't had time to act on, then overshoots when the
   matches catch up. This inflates effective loop gain exactly and only during
   follow — matching the observed "destabilizes when attempting to follow up".
2. **Setpoint kick in the derivative.** The derivative acts on `de/dt`, and
   `e` includes `aT`: every tracker update rides `d(aT)/dt` straight into the
   output at tracker rate. The new low-pass bounds it but does not remove it.
3. **Feed-forward double-counting.** Compose already applies motion lead:
   `V = V_pid + J·(p_pred − p_meas)`. The PID *also* chases the same motion
   through channel 1, so target velocity is corrected twice — the faster the
   target, the hotter the effective gains.

**Improvements (R1/R2 IMPLEMENTED 2026-07-12; R3 open):**

- **R1 — error against the capture-epoch target.** Keep a short ring of
  `{t, target}` from every target write; in `onMatch`, look up the target at
  the strip frame's capture timestamp and feed THAT as `projection.target`.
  The PID then regulates only the true residual; motion since capture is
  entirely feed-forward's job (which the IMM already leads). Kills
  channels 1 + 3.
- **R2 — derivative on measurement.** `PID.step` learns an optional
  measurement-derivative form (`d(−measurement)/dt` instead of `de/dt`):
  standard anti-setpoint-kick. Kills channel 2 for all consumers; the vergence
  law passes the decomposed measurement per DOF.
- **R3 — verify with the follow experiment** from §1's cost harness (scripted
  moving target), before/after traces into `docs/dev/`.

::: details R1 + R2 implementation (2026-07-12) — behavior spec at [disparity-scope §control-law](../spec/disparity-scope.md#capture-epoch-target)
- **No protocol change was needed for R1.** The strip frame's capture epoch was
  already carried end to end: `Frame` stamps `device_timestamp` PRE-CALIBRATED
  into the host `steadyNowNs` domain at creation (the trusted-time choke
  point), every brick (convert → undistort → slice → scale) forwards it
  un-restamped, the shm slot header carries it, and the template-match kernel
  already surfaced it as `TemplateMatchValues.deviceTimestamp` /
  `VisionResult.deviceTimestamp`.
- **Ring** = `recordTarget`/`targetAtEpoch` (pure, `vergence.ts`, unit-tested):
  host-ns `{t, target}` samples via the session's single `writeTarget` path
  (tracker `onTrack`/`onDrag`, pointer handler, lost-hold), nearest-not-after
  lookup, live-target fallback for empty/missing/pre-coverage epochs (the
  uncalibrated-clock degrade = exactly the pre-R1 behavior).
- **Boundary kept:** `pushVolts`' `pMeas` and the drag re-affirm stay on the
  LIVE target — only the PID error decomposition moved to the epoch.
- **R2** = `derivativeOn: "error" | "measurement"` on `@lib/pid` (default
  `"error"`, zero change for existing consumers; PID2D forwards a per-axis
  measurement point). All three vergence controllers run measurement mode.
  Only PAN actually changes behavior — verge/v_shift regulate to a constant
  0-disparity setpoint, where measurement mode is numerically identical.
:::

R1 is the high-value one; R2 is small and general; both are independent.
