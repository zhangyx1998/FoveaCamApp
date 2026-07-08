# Tracking (Multi) / Multi-fovea

**Seed confidence: RAISED to HIGH for the scheduling/relay/teardown story
(derived from code 2026-07-08, auditor) — but the seed's "fovea tiles are live
`fovea:<index>` session frames" claim is WRONG: no such producer exists (blank
by design until Stage-F). One real bug found and fixed: the frame scheduler was
never started.**

## Purpose
Multi-target tracking: the user enables/places/steers up to
`MAX_MULTI_FOVEA_TARGETS` (8; the UI exposes 4) targets on the center view. Each
enabled target gets a KCF track (on the main loop) and, on v2 hardware, one
controller "stream" — a saved L/R mirror-pose pair the round-robin scheduler
time-multiplexes the two physical mirrors across. Real synced frame capture is
Stage-F hardware-gated; on the current rig `createStream` returns null and the
capture command returns `stage-f-hardware-gated`.

Note "add/remove" is really enable/disable + place: `state.targets` is a
fixed-length slot array (default 4), not a growable list. Removal == disable.

## Pipeline (post-real-1g)
Session: triple + `undistort:<C>` advertised; a MINIMAL relay worker (`display`
kernel, `view:"diff"` + `relayCenter:true`, only the C pipe connected) posts the
undistorted center as a `C` frame **solely** to feed `runtime.onCenterFrame` —
the multi-target KCF runs ON THE MAIN LOOP (known exception; queued
async-kcf→C++ refactor). VERIFIED: `relayCenter` → display kernel
`out.push({name:"C"})` → `onResult` (`f.name==="C"`) → `runtime.onCenterFrame`.
The renderer binds the `undistort:<serial>` pipe directly for the wide view
(raw fallback uncalibrated).

**Fovea image tiles are NOT wired.** `index.vue`'s per-target tile binds
`session.frame("fovea:<index>")`, but nothing in the session (or anywhere) ever
publishes a `fovea:<i>` frame — the only contract frame is `["C"]`. So the tiles
are permanently blank. This is expected: the actual per-target fovea imagery
comes from the v2-controller synced camera streams (`StreamHandle`), which are
Stage-F hardware-gated and not yet bridged to session frames (the `fovea:`
dynamic-pipe cut-over is future work — see project memory). The seed's "adding a
target spawns its fovea tile live" is aspirational, not current behavior.

**Mirror scheduling across N targets (derived).** Each enabled target with a
stream becomes one `ScheduledFrameTarget {stream, pulse, cameras:["L","R"]}`.
`RoundRobinFrameScheduler` advances a cursor across those targets, issuing up to
`maxInFlight` (≤ `FRAME_QUEUE_CAPACITY` = 8) concurrent `CMD_FRAME` requests —
one per stream. Each request repositions BOTH physical mirrors to that stream's
volts and captures a synced L+R pulse; `minIntervalMs`/`retryDelayMs` throttle
per-stream re-issue and back off rejects/timeouts. So the 2 mirrors serve N
targets by round-robin time-multiplexing, not by any per-target slicing.

## UI & controls
Center view with per-target select (radio) + enable (checkbox); drag = steer
(`steerTarget`), release/click = place (`placeTarget`); reset; capture (gated).
Per-target tiles show a (currently blank) fovea view + volt/stream telemetry.

## Expected behavior
Enabling a target starts its KCF track and (v2) its stream; disabling releases
both without disturbing others; the center overlay marks every enabled target's
bbox/center. Fovea tiles stay blank until Stage-F wires per-target imagery.

## Known/suspected issues
- **Scheduler never started — BUG, FIXED (in this app's lane).** `activateSession`
  deferred `scheduler.stop()` but never called `scheduler.start()`, so
  `running` stayed false and `pump()` early-returned — no `CMD_FRAME` would ever
  be issued once v2 hardware lands. The activation comment ("the drain stops the
  scheduler") confirms it was meant to run. Added `scheduler.start()` before
  `applyTargets()` (session.ts). Inert on the current rig (`createStream` returns
  null when `!v2Capable` → empty scheduler targets → nothing to pump), so no
  behavior change today. **RIG-GATED:** only observable with Stage-F v2 hardware.
- **Multi-target KCF on the main loop** — the one remaining on-loop vision
  (documented exception; do NOT fix here — the async-kcf→C++ follow-up).
- **Fovea tiles blank** — expected (no `fovea:<i>` producer; Stage-F gated). Not
  a leak, not a crash — a static `StreamView` bound to a channel that never
  emits. See Open questions for a possible placeholder.
- **Target-churn teardown — VERIFIED, no leaks.** `releaseSlot` releases the KCF
  (`tracker.release()`) and closes the stream (`stream.close()`); `setTargets`
  releases on disable/config-change and slices off trailing slots; `dispose`
  releases every slot and clears the scheduler. Generation-guards drop
  stale-async tracker/stream completions. There is no per-target frame channel or
  UI tile to leak (tiles are fixed `v-for` over `state.targets`). Covered by
  `test/multi-fovea-runtime.test.ts` (stream-close-after-dispose, reinit on
  center change, in-flight-create rerun).
- **Click coordinate space — CORRECT** (same as manual-control):
  `targetPose` uses `undistort.angular([center], false)` and clicks land on the
  undistorted pipe, so the `false` (already-undistorted) flag is right.

## Open questions (for the user)
1. **Was the missing `scheduler.start()` intentional Stage-F gating?** The
   deferred `stop()` and the "drain stops the scheduler" comment say no (it reads
   as an oversight), and the added `start()` self-gates via empty targets on
   non-v2 rigs. If you deliberately want the scheduler dormant until a separate
   Stage-F switch, revert the one-line add.
2. **Hardcoded pose depth.** `targetPose` calls
   `inverseTriangulate(angle, 200, 1000, radians(0))` — baseline 200 mm, distance
   1000 mm, zero shift, all fixed (unlike manual-control's verge/baseline/shift
   state). Intended fixed default for the skeleton, or should multi-fovea expose
   baseline/distance controls?
3. **Blank fovea tiles.** Until Stage-F wires per-target imagery, should each
   tile show an explicit "hardware-gated / no stream" placeholder instead of a
   silently-empty `StreamView`?
4. **placeTarget stream churn.** A center change makes `setTargets` see the
   config as "changed" → `releaseSlot` closes the v2 stream and `syncStreams`
   recreates it, rather than `stream.update()`-ing the new pose. Re-init of the
   KCF at the new center is correct; the stream close+recreate on every placement
   may be heavier than needed once hardware is live — confirm desired.
</content>
