# Tracking (Multi) / Multi-fovea

**Updated 2026-07-08 for the C-24 flagship refactor (7e71eef) + native
multi-KCF (B-25).** Earlier audit notes about a relay worker, main-loop KCF,
and permanently-blank fovea tiles are SUPERSEDED: the C-22b relay worker is
gone, tracking runs on a native multi-KCF thread, and the per-target fovea
tiles are now LIVE renderer-composed nodes with real pixels. The frame
scheduler bug (never started) was fixed earlier in this app's lane.**

## Purpose
Multi-target tracking: the user enables/places/steers up to
`MAX_MULTI_FOVEA_TARGETS` (8; the UI exposes 4) targets on the center view. Each
enabled target gets a KCF track (on the native multi-KCF thread) and, on v2
hardware, one
controller "stream" — a saved L/R mirror-pose pair the round-robin scheduler
time-multiplexes the two physical mirrors across. Real synced frame capture is
Stage-F hardware-gated; on the current rig `createStream` returns null and the
capture command returns `stage-f-hardware-gated`.

Note "add/remove" is really enable/disable + place: `state.targets` is a
fixed-length slot array (default 4), not a growable list. Removal == disable.

## Pipeline (post-C-24 flagship, 2026-07-08)
Session: triple + `undistort:<C>` advertised. Tracking runs on B-25's **native
multi-KCF thread** (`createMultiTracker`: one free-running thread, batched
per-frame results, fused undistort → results in UNDISTORTED coordinates when
calibrated), bound to the shared center stream. The C-22b relay worker is GONE —
nothing multi-fovea does touches the JS event loop per frame anymore. The session
consumes the batch iterator into the runtime's policy half (arm/disarm churn,
lost tolerance, steering, controller streams) and drives each slot's composed
fovea crop node (`setFoveaRect` per tick — frame-bound origin rides the pipe, v4).
The renderer binds the `undistort:<serial>` pipe directly for the wide view
(raw fallback uncalibrated).

**Fovea image tiles ARE wired now (C-24 step 4).** The RENDERER composes the
per-target fovea crop nodes — a camera-rooted
`camera/<serial>/undistort/fovea/<slot>` brick via `compose` (refcounted,
auto-unref on window close; disabling a target decomposes) — and binds each
node's pipe via `usePipeFrame`. These tiles get REAL pixels (the old
`session.frame("fovea:<i>")` had no producer; that path is retired). Real
*synced* frame CAPTURE (recorder-bound) is still Stage-F hardware-gated.

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
Per-target tiles show the live composed fovea view + volt/stream telemetry.

## Expected behavior
Enabling a target starts its KCF track and (v2) its stream; disabling releases
both without disturbing others; the center overlay marks every enabled target's
bbox/center. Each enabled target's fovea tile shows live composed pixels;
disabling decomposes its node.

## Known/suspected issues
- **Scheduler never started — BUG, FIXED (in this app's lane).** `activateSession`
  deferred `scheduler.stop()` but never called `scheduler.start()`, so
  `running` stayed false and `pump()` early-returned — no `CMD_FRAME` would ever
  be issued once v2 hardware lands. The activation comment ("the drain stops the
  scheduler") confirms it was meant to run. Added `scheduler.start()` before
  `applyTargets()` (session.ts). Inert on the current rig (`createStream` returns
  null when `!v2Capable` → empty scheduler targets → nothing to pump), so no
  behavior change today. **RIG-GATED:** only observable with Stage-F v2 hardware.
- **Multi-target KCF off the main loop — RESOLVED (B-25).** Tracking moved to
  the native multi-KCF thread (`createMultiTracker`); the old per-slot JS KCF
  (busy-drop + generation guards) is gone. No on-loop per-frame vision remains.
- **Fovea tiles live — RESOLVED (C-24 step 4).** The renderer-composed
  `camera/<serial>/undistort/fovea/<slot>` nodes give each enabled target real
  pixels via `usePipeFrame`; disabling decomposes the node.
- **Target-churn teardown — VERIFIED, no leaks.** `setTargets` releases slots on
  disable/config-change and slices off trailing slots; `dispose` releases every
  slot and clears the scheduler; the composed fovea nodes decompose (refcounted,
  server-side auto-unref on window close). Generation-guards drop stale-async
  completions. Covered by `test/multi-fovea-runtime.test.ts` (stream-close-after-
  dispose, reinit on center change, in-flight-create rerun).
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
3. **Fovea tiles (RESOLVED).** Per-target imagery is now live via composed
   fovea nodes; the earlier "blank tile placeholder" question is moot. Real
   *recorder-bound synced capture* remains Stage-F hardware-gated.
4. **placeTarget stream churn.** A center change makes `setTargets` see the
   config as "changed" → `releaseSlot` closes the v2 stream and `syncStreams`
   recreates it, rather than `stream.update()`-ing the new pose. Re-init of the
   KCF at the new center is correct; the stream close+recreate on every placement
   may be heavier than needed once hardware is live — confirm desired.
