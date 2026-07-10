# IMM delay compensation (motion predictor after the tracker)

Status: **CODE-COMPLETE (2026-07-10, `9fc4f0c`; rig pass owed — `hardware/stage-f.md`
§Disparity Scope → "Delay compensation")**.

User directive: chain an **Interacting Multiple Model (IMM) Kalman-filter
motion predictor** after the disparity-scope tracker to offset tracking-chain
delay, with a per-triple **"Delay Compensation" (ms)** setting.

## Problem

The chained hybrid-NCC tracker (`createChainedHybridTracker`, disparity-scope
§3.5) emits target centers stamped with a TRUSTED device timestamp. By the time
the PID/mirrors act on a result the target has moved — a fixed transport +
compute latency the mirrors always trail. Feeding downstream the target's
ESTIMATED position at `t_result + delay` cancels that lag.

## Sign convention

`delay_compensation_ms` is a **SIGNED** millisecond value on the triple's config
doc:

- `> 0` → predict INTO THE FUTURE (lead): offsets the tracking-chain latency so
  the mirrors sit where the target WILL be.
- `< 0` → retrodict into the past (lag).
- `0` / absent → **EXACT PASSTHROUGH**: the predictor is inert; the tracker
  result flows through byte-for-byte, zero behavior change (and no imm node is
  wired at all). The default is 0.

## Filter

`app/lib/imm-predictor.ts` — a PURE, timestamp-driven `ImmPredictor` class
(types-only core imports; no Vue, no native addon). Mirrors the pid-node
precedent: per-result scalar math run at the tracker's RESULT rate, unit-tested
in vitest (`app/test/imm-predictor.test.ts`).

### Model set

Three models over a SHARED augmented per-axis state `[pos, vel, acc]`; the
models differ ONLY by their transition `F(dt)` and process-noise `Q(dt)`, so
IMM mixing across them needs no dimension bookkeeping:

| Model | `F` collapses | Process noise `Q` | Captures |
|-------|---------------|-------------------|----------|
| **CP** constant position | zeros vel + acc | random-walk position PSD | a stopped / near-stationary target |
| **CV** constant velocity | zeros acc | white-noise-**acceleration** PSD | steady drift |
| **CA** constant acceleration | full kinematic `F` | white-noise-**jerk** PSD | a maneuvering / accelerating target |

Defaults (AS-BUILT; rig-tunable via `ImmPredictorConfig`): measurement variance
`R = 4` px² (≈2 px std), `cvAccelPsd = 400`, `caJerkPsd = 5000`, `cpPosPsd = 1`,
innovation gate `30` (χ², 2 dof), `maxGapMs = 500`. Transition matrix is
self-biased (CP/CV/CA self-transition 0.94/0.90/0.90), renormalized when a model
subset is used (a single-model config collapses the IMM to a plain KF — the
tests use `models: ["ca"]` to contrast a pure-CA filter's post-stop overshoot).

### Axes

The two axes are filtered **INDEPENDENTLY** (two decoupled scalar-position
IMMs). Justification: the tracker's per-axis measurement noise is independent
and image-plane motion carries no dynamic cross-axis coupling, so decoupling
keeps every matrix ≤ 3×3 and explicit (scalar-measurement KF update, no matrix
inverse); a 2D maneuver is still captured because each axis detects its own
acceleration. The one shared decision is the innovation GATE, evaluated JOINTLY
across both axes (a teleport moves both filters together).

### IMM cycle (per result, `dt` from trusted timestamps)

`dt = (deviceTimestamp − lastTimestamp) / 1e9` seconds — never wall clock,
never an assumed frame interval (timestamps between nodes are always trusted,
per the ruled invariant). Per axis per step:

1. **Mixing** — `c̄_j = Σ_i p_ij μ_i`, mixing weights `μ_{i|j}`, mixed initial
   `x0_j` / `P0_j`.
2. **Per-model predict** — `x⁻ = F_j x0_j`, `P⁻ = F_j P0_j F_jᵀ + Q_j(dt)`
   (symmetrized).
3. **Joint gate** — combined predicted measurement + variance vs the actual
   measurement; above the gate → reinit at the measurement (below).
4. **Per-model update** (found) — scalar KF update (`H = [1,0,0]`), likelihood
   `Λ_j`; **or** no-update (miss) — keep the predicted models, roll `μ` to the
   predicted `c̄`.
5. **Probability update** — `μ_j ∝ c̄_j Λ_j`.
6. **Combination** — `x = Σ μ_j x_j`, `P = Σ μ_j (P_j + (x_j−x)(x_j−x)ᵀ)`.

### Output

The combined estimate `[p, v, a]` per axis is PROPAGATED by the delay using full
kinematics: `p + v·Δ + ½·a·Δ²`, `Δ = delayMs/1000` (signed — negative
retrodicts; the filter is NOT run backward, only the single best estimate is
advanced). `center` is replaced by the propagated point; `bbox` is shifted by
the SAME delta (size unchanged); `found` / `seq` / `deviceTimestamp` /
`overridden` are preserved.

### Reset / passthrough / guard semantics

- **delay = 0** → return the argument object UNMODIFIED (exact passthrough).
- **overridden (drag)** → pass through UNTOUCHED and RESET the filter (a drag
  teleports the target; resuming from stale dynamics would yank the mirrors).
- **found = false (miss)** → predict-only (covariance grows), the result passes
  through unchanged (found=false, center=null) — the downstream JS lost-gate
  owns the policy.
- **first result / dt ≤ 0 / gap > maxGapMs / gated discontinuity (teleport,
  re-arm)** → reinit at the measurement, passthrough that result.
- **numerical hygiene** — covariances symmetrized every step; any NaN/Inf escape
  → reset + passthrough (never emit a poisoned center).

## Graph node

`app/orchestrator/imm-node.ts` — `createImmNode` wraps the pure filter with the
graph responsibilities the pid node has (`registerGraphWiring` +
`registerWorkload`). Node id `nodeId.imm(kcfId)` = `…/undistort/kcf/imm`
(nests under its source tracker). It registers the `tracker → imm` INCOMING
edge + the node; the `imm → pid` edge is the pid node's input (edge ownership by
the consumer, exactly as the old `kcf → pid` edge was). Self-meters one unit
in + out per prediction so both edges read truthful rates. Topology:

```
kcf → pid                    (delay 0 — imm inert, not wired)
kcf → imm → pid              (delay ≠ 0)
```

The disparity-scope session (`app/modules/disparity-scope/session.ts`)
constructs the node at activation ONLY when `delayIsActive(triple
.delayCompensationMs)`, wraps the tracker feed
(`trackerFeed(immNode ? immNode.process(r) : r)`), and points the pid node's
`target` input at the imm node when present.

## Per-triple config

Key `delay_compensation_ms` (SIGNED number, ms; 0/absent = off) on
`["triples", <hash>]`, following the `settle_time_us` / `zoom_override` /
`baseline_mm` pattern:

- `TripleConfig.delay_compensation_ms` (`@lib/calibration-data`) + a signed
  friendly-name flag (`delay +12.5 ms`).
- `CalibratedTriple.delayCompensationMs` (`@orchestrator/calibration`) — resolves
  to a number (0 = off), accepts any finite value (negative valid).
- Settings → **Device config** tab → per-triple **Delay compensation** field
  (ms, integer step, range −50…+50, "none" at 0, next-session-applies hint). No
  drawer slider (Settings entry only, per the directive).

## Settings restructure (addendum, same lane)

The Settings body (`app/src/windows/ConfigBody.vue`) was reorganized around the
per-triple surface into TWO tabs behind a fixed (non-scrolling) header:

- **Global config** — app-wide settings (save dir, record compression,
  TeleCanvas, marker size/ratio, anaglyph style).
- **Device config (per-triple)** — a triple SELECTOR (first item; opens a
  centered, scrollable modal reusing the `.modal-scrim`/`.modal` shell) that
  defaults to the CONNECTED rig (resolved via `connectedTripleHash`, badged with
  a plug icon) and lists every configured triple connected-first
  (`orderTriples` / `defaultTripleSelection`, pure + unit-tested). The selected
  triple's overrides (zoom, baseline, settle, delay) edit inline; a
  disconnected triple is still selectable + editable ("not connected" chip).

**Mapping note (calibration-data manager):** a triple's hash is not reversible
to its L/C/R camera keys, so intrinsic/extrinsic docs can't be auto-scoped to a
DISCONNECTED triple. The full calibration inventory therefore stays reachable +
deletable under the Device tab (orphaned entries for disconnected rigs
included); only the editable per-triple OVERRIDES are scoped to the selected
rig. Connected triples are badged in the inventory with the plug icon.

## Files

- `app/lib/imm-predictor.ts` — pure IMM filter + `process` + `delayIsActive`.
- `app/orchestrator/imm-node.ts` — graph node wrapper.
- `app/lib/orchestrator/graph-contract.ts` — `nodeId.imm`.
- `app/modules/disparity-scope/session.ts` — construct/wire/dispose; feed wrap;
  pid `target` re-source.
- `app/lib/calibration-data.ts` — `delay_compensation_ms`, friendly-name flag,
  `connectedTripleHash` / `orderTriples` / `defaultTripleSelection` /
  `TripleListItem`.
- `app/orchestrator/calibration.ts` — `CalibratedTriple.delayCompensationMs`.
- `app/lib/coordinate-conversions.ts` — carry `delay_compensation_ms` through.
- `app/src/windows/ConfigBody.vue` — two-tab restructure + selector modal +
  delay field.
- Tests: `app/test/imm-predictor.test.ts`, `app/test/imm-node.test.ts`,
  `app/test/calibration-data.test.ts` (selector + delay-flag additions).
