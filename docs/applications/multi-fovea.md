# Tracking (Multi) / Multi-fovea

**Seed confidence: MEDIUM — auditor must verify the fovea scheduling story.**

## Purpose
Multi-target tracking: the user adds/removes targets on the center view; each
target gets a KCF track and a fovea stream (`fovea:<index>` session frames).
Fovea streams are created/destroyed at runtime (targets churn) — the flagship
dynamic-composition case for the node graph (real-2).

## Pipeline (post-real-1g)
Session: triple + `undistort:<C>` advertised; a MINIMAL relay worker
(`display` kernel, `relayCenter` param) posts the undistorted center solely to
feed `runtime.onCenterFrame` — the multi-target KCF still runs ON THE MAIN LOOP
(known exception; queued async-kcf→C++ refactor). Fovea frames are produced by
the session runtime (slice per target?) onto `session.frame("fovea:<i>")` — the
legacy viewer transport, NOT pipes yet (the fovea: dynamic-pipe cut-over is
future work, see project memory). Mirror scheduling across multiple targets
(time-multiplexing?) — VERIFY: how do 2 mirrors serve N targets?

## UI & controls
Center view w/ target add/remove (click), per-target fovea tiles
(`session.frame("fovea:<i>")` bindings), target list state.

## Expected behavior
Adding a target spawns its fovea tile live; removing kills it without
disturbing others; KCF per target follows; center overlay marks all targets.

## Known/suspected issues
- Multi-target KCF on the main loop = the one remaining on-loop vision
  (documented exception; do NOT fix here — it's the async-kcf→C++ follow-up).
- Fovea tiles ride the legacy session-frame transport — expected; note perf but
  don't migrate (real-2 does it).
- Verify target-churn teardown (remove mid-track) leaks nothing (KCF instance,
  frame channel, UI tile).

## Open questions (for the user)
(auditor fills)
