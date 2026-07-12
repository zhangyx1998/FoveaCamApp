# Disparity-scope mirror flicker — findings & fix

Investigated at `a11c471` (2026-07-11). Symptom: in disparity-scope the mirrors
flicker between the expected position and a second position, resembling
multi-fovea frame-switching while only one stream is active; persists during a
wide-canvas drag (manual override).

## TL;DR

Two independent defects produce the same wire signature — the single active
`CMD_STREAM`'s target alternating between two poses, which the MEMS follows.
That is visually identical to multi-fovea's `Streams::activate()` switching,
but here it's one stream whose *value* ping-pongs.

- **D1 (explains the drag flicker, definite bug):**
  `trackerFeed.onDrag` rebases the compose brick with the **un-slewed**
  `followVolts(center)` while the pointer handler and the match path rebase
  with the **slewed** pose. Three writers interleave at ~60 Hz each; the
  compose floor alternates between two trajectories separated by the slew lag.
- **D2 (explains the tracking flicker, design defect in the new brick):**
  `ComposeStream` emits the **raw baseline floor on every rebase** (~60 Hz)
  even while feed-forward is healthy — every pid tick momentarily rescinds the
  IMM feed-forward lead, then the next 600 Hz prediction tick re-applies it.
  Sawtooth amplitude = `J·(p_pred − p_meas)`, growing with target speed and
  delay compensation; under serial pressure (AIMD governor throttling
  prediction ticks) the floor holds longer and the flicker becomes gross.

## Wire model (why it looks like multi-fovea)

Firmware (`firmware/src/Streams.cpp`): exactly one `activeId` stream drives
the DAC; `tick()` applies `table[activeId]` whenever `dirty`. In
disparity-scope no `CMD_FRAME`s fire (only multi-fovea calls
`controller.frame()` — `app/modules/multi-fovea/session.ts:129`), so the only
mirror driver is the native compose path:

```
kcf/hybrid ─(track_out)→ imm brick ─(600 Hz pred)→ ComposeStream ─→ MirrorSink → CMD_STREAM UPDATE
session pushVolts() ────(~60 Hz rebase: {vPid, pMeas, J, feedForward})──↑
```

`ComposeStream::iterate()` (`core/src/ComposeStream.cpp:128-151`):
- prediction tick + `feedForward && found && hasCenter` → emits
  `vPid + J·(pred − pMeas)`
- **floor tick (`ev == nullptr`, queued by every `rebase()`) → emits raw
  `vPid`** regardless of feed-forward health.

The MirrorSink gate dedupes *identical consecutive* poses (1 ms min interval).
Two alternating poses are never identical → every alternation reaches the
wire. The mirror faithfully follows the alternation. That's the flicker.

## D1 — drag: one un-slewed writer among slewed writers

During a drag, three code paths rebase the brick with `commandedVolts`:

| Writer | Rate | Pose pushed |
|---|---|---|
| `pointer` command, `app/modules/disparity-scope/session.ts:1626-1629` | per pointer move (~60–120 Hz) | `slewToward(followVolts(p))` ✓ slewed |
| `controlStep` manual branch (via `onMatch` → `runControl`), `session.ts:736-738` | match rate (~60 Hz) | `slewToward(followVolts(target))` ✓ slewed |
| **`trackerFeed.onDrag`, `session.ts:564-567`** | overridden tracker results (~60 Hz) | **`followVolts(center)` — NOT slewed** ✗ |

```ts
// session.ts:556-568 (onDrag) — the bug
const v = followVolts(center);
if (v && !pidNode?.override.engaged) {
  commandedVolts = v;        // ← raw target pose, bypasses drag slew
  pushVolts();
}
```

With τ = 8 ms (`drag-slew.ts DRAG_SLEW_TAU_MS`), the slewed pose lags the raw
target by the pointer motion of the last ~8–16 ms. While the pointer moves,
the compose floor is rebased alternately with the lagging pose and the raw
pose at a combined ~120–240 Hz → mirrors flicker between the two. It converges
(both writers agree) only when the pointer holds still for a few τ.

History: the drag-slew was added in the 2026-07-11 value-sweep
(`53ba728`, spec §drag-slew) and the pointer + match paths were converted; the
`onDrag` re-affirm (comment: "covers a coalesced-away pointer move") was
missed. Note the writer-2 comment even says "slewed like the pointer path".

Side effect: the alternation also defeats the MirrorSink dedupe that
§drag-slew's design relies on ("compose floor re-emits an IDENTICAL pose,
which the gate dedupes away") — so it burns serial budget too.

### Fix (one line)

```ts
// session.ts onDrag:
commandedVolts = slewToward(v);   // match the pointer path (spec §drag-slew)
```

Alternative (also defensible): delete the volts push from `onDrag` entirely —
the pointer handler pushes synchronously and the match path re-affirms at
match rate; the tracker-feed re-affirm predates the slew and is redundant.
Keep `lastGood`/`setState`/`steerCrops`/`publishOverridden` — only the
`followVolts`+`pushVolts` block goes.

### Test

Session-level (fake compose seam recording `rebase()` calls): drive a drag
with interleaved pointer / overridden-tracker / match events over a moving
target; assert the pushed `vPid` sequence is monotone along the slew
trajectory (no alternation — successive rebases never regress toward the
un-slewed target by more than slew math allows). Today's code fails this
immediately.

## D2 — tracking: floor ticks rescind the feed-forward

`ComposeStream::rebase()` (`ComposeStream.cpp:104-112`) queues a floor tick
(`events_.write(nullptr)`) on **every** pid rebase, and `iterate()` emits the
raw baseline for it. Intent (planner decision 4) was "mirrors always driven,
warm or cold" — the floor is needed while the IMM is cold. But while
feed-forward is healthy, each 60 Hz rebase writes `vPid` (no lead) to the
wire between 600 Hz ticks writing `vPid + J·(pred − pMeas)`:

```
wire: …, pred, pred, pred, FLOOR(vPid), pred, pred, …   ← 60 Hz sawtooth
```

Amplitude = the feed-forward lead: `J·(pred − pMeas)` ≈ J · v_target ·
(delay_compensation_ms + serial-latency comp + coast). Small for a static
scene; visible for a moving target or a large configured delay. It gets much
worse under serial pressure: the AIMD rate governor throttles the prediction
tick rate while rebases (floor ticks) keep coming — the floor pose then holds
for many ms per cycle → pronounced alternation between "predicted" and
"un-predicted" poses. Because the two poses differ, the MirrorSink dedupe
never suppresses them.

(During a drag `feedForward=false`, so floors and prediction ticks both emit
the baseline — D2 contributes nothing there; D1 is the drag mechanism. The two
defects are independent, same symptom.)

### Fix

Cache the last prediction in the brick and make floor ticks apply the same
feed-forward math against the **new** linearization:

```cpp
// ComposeStream member:
ImmResult::Ptr lastPred_;   // owned by the brick thread only

// iterate():
if (ev) lastPred_ = ev;                         // prediction tick
const ImmResult::Ptr &p = ev ? ev : lastPred_;  // floor reuses latest pred
if (p && r.warm && r.feedForward && p->found && p->hasCenter) {
  ... same delta math ...
}
```

Semantics: a rebase now re-linearizes (new `vPid`/`pMeas`/`J`) and the floor
emit applies the newest prediction against it — no dip. Cold brick (no
prediction ever) still emits the raw baseline, preserving planner decision 4.
Two refinements worth ruling on:

1. **Staleness bound** — ignore `lastPred_` older than ~2 prediction periods
   (compare a stamped `propagatedToNs`/host ns against now) so a stalled imm
   brick degrades to the floor instead of feeding a frozen lead forever. This
   mirrors the existing "staleness bounds" value-sweep discipline.
2. **Conformance** — the TS reference (`app/orchestrator/compose-node.ts
   composeVolts`) is pure and unchanged; the FLOOR policy lives in
   `iterate()`. Extend `docs/schema/codec/compose-vectors.json` + the paired
   suites (`core/test/42-imm-predictor.ts` / `app/test/imm-conformance.test.ts`
   or the compose equivalents) with a "rebase between predictions emits no
   baseline dip" sequence vector so both implementations pin the policy.

### Test

Brick-level (`core/test/`, synthetic feed): pump predictions with a constant
lead at 600 Hz, interleave rebases at 60 Hz with `feedForward=true`; assert
every emitted pose includes the delta (max deviation over the run < ε), and
that with **no** predictions the floor still emits (cold path). Today's brick
fails the first assertion on every rebase.

## Secondary observations (not the cause, worth noting)

- `rebase_` swap vs in-flight prediction tick: a tick dequeued just after a
  rebase applies the *new* `pMeas`/`J` to a prediction propagated for the old
  linearization — one-tick transient, bounded, ignorable.
- `s.state.target` as `pMeas` is the tracker center from `onTrack` (same
  source as the IMM's measurements, undistorted-C px), so coordinate frames
  agree — checked `trackerSrc.pipe = cSourceId` (`session.ts:984`), tracker
  centers are full-res undistorted-C, no scale mismatch.
- Firmware handoff semantics are not implicated: with the
  `dual-cmd-stream-handoff-race` suppression (53ba728) there is exactly one
  live stream in scope sessions, and no `CMD_FRAME`/`activate()` churn.

## Addendum (2026-07-12): runaway-predictor risk — yes, one real path

Question raised: can the motion predictor run away? Audited `ImmPredictor.cpp`,
`ComposeStream.cpp`, the MirrorSink math, and the session gates. Verdict: one
genuine unbounded-extrapolation path exists, capped only by the wire clamp.

### R1 — source stall ⇒ unbounded coast (real, needs a guard)

`ImmCore::predictAt` (`core/src/ImmPredictor.cpp:507-523`) propagates the full
`[p, v, a]` state by `coastSec + delaySec` where `coastSec` = wall-clock since
the last measurement — **no maximum coast**. CA-model extrapolation is
quadratic in elapsed time, and results keep carrying `found=true,
hasCenter=true`. Every existing safety mechanism is **event-driven** — it
needs a result to *arrive*:

- `maxGapMs` (500 ms) resets only inside `ingest()` — on the *next* measurement.
- The JS lost policy (`tracker-feed.ts`, 10 consecutive misses → `onLost`)
  needs found=false results to be delivered.
- `composeHealthy()` flips `feedForward` only at the *next rebase*.

If the measurement source stalls outright — wedged tracker thread, stalled
camera pipe, dropped `kcf→imm` link during a slow hot-swap (`measureLink` is
released before the new tracker re-pipes, `session.ts:519-527`) — no results
arrive, `trackerActive` stays true, rebases keep `feedForward=true`, and the
compose brick applies a quadratically growing `J·Δp` at the prediction rate.
If the match path stalls too, rebases stop but the brick keeps emitting
against the frozen last rebase (`r.feedForward=true` persists in the Guard);
nothing in `iterate()` checks prediction age. Mirrors ramp until the clamp.

**The hard floor that exists:** `chPair` clamps each differential pair to
±dv/2 and `volt2dac` clamps 0..65535 (`Controller.cpp:1585-1607`, identical
in `@lib/controller-codec`). So runaway pegs the mirrors at the configured
`dv` limit — no DAC wraparound, no over-range command. Physical safety rests
entirely on the device-configured `dv` being within MEMS-safe deflection;
the failure mode is a slam-to-range-edge-and-pin, not an unbounded command.

### R2 — uncapped adaptive lookahead (slow drift, cheap to cap)

With `serial_latency_comp` on, `applyDelay(fixedDelayMs + EMA(RTT)/2)`
(`session.ts:1487`) has **no upper bound**, and the imm brick clamps only
`rateHz`, never `delayMs`. Congestion → RTT grows → lookahead grows → larger
per-tick deltas defeat the MirrorSink dedupe → more traffic → more
congestion. The AIMD governor counter-pressures sends and the 2 Hz/α=0.25 EMA
is slow, so this drifts rather than explodes — but nothing clamps it.

### What does NOT run away (verified)

No physical feedback loop: the tracker measures the wide (C) camera, which
the mirrors don't steer — predictions cannot excite their own measurements.
Overridden (drag) results hard-reset the filter (`warm_=false` →
`predictAt` returns null) and `feedForward=false` during drag anyway. The
joint innovation gate (χ²=30) reinitializes on teleports instead of chasing;
degenerate covariance and non-finite propagation both reset; pid integrators
are limit-clamped and the override slot resets them per tick.

### Guards to add (ordered)

1. **Coast cap in the brick** — in `predictAt`, when `coastSec` exceeds
   ~2–3 tracker periods (or reuse `maxGapMs`), emit the miss-coast shape
   (`found=false, coasting=true`) instead of extrapolating. One branch; kills
   R1 regardless of JS state. Mirror it in the TS reference + vectors.
2. **Prediction-age gate in `ComposeStream::iterate()`** — carry the last
   measurement's wall-ns in `ImmResult` and skip feed-forward when older than
   a bound. Belt-and-suspenders with #1, and it's the same staleness bound
   the D2 `lastPred_` fix needs anyway.
3. **Deadline-based lost policy in the session** — a watchdog: no tracker
   result within N ms while `trackerActive` ⇒ treat as lost (the count-based
   `onLost` only covers delivered misses).
4. **Clamp `delayMs`** at `applyDelay` (e.g. total ≤ 30–50 ms) and ignore
   absurd RTT samples beyond a ceiling.
5. Optional volt-space bound on the composed delta (`|J·Δp|` ≤ a fraction of
   `dv`) directly in the brick — cheapest guard expressed in the actuated
   quantity.

## Suggested landing order

1. D1 one-liner (`slewToward` in `onDrag`) + the session test — kills the drag
   flicker outright.
2. D2 brick fix (`lastPred_` + staleness bound) + vector + tests — kills the
   tracking sawtooth; re-run the rig check from `prediction-compose-node.md`
   RIG-GATED list (feed-forward leads a moving target, drag passes override
   volts untouched).
3. While in there: add a profiler sanity check — with the fix, the `compose →
   controller` volt edge under a steady drag should settle to the gate's
   dedupe-quiet state once the slew converges (today it stays busy because the
   alternation defeats dedupe).
