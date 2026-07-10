# SGBM signed disparity range (foveated gaze)

Status: **SHIPPED (2026-07-10; rig pass owed).** Both attach sites now pass
the shared `SIGNED_DISPARITY_WINDOW` constant (`app/orchestrator/
stereo-pipe.ts`); the sign convention (`disparity = x_left − x_right`) is
pinned on both signs by the `core/test/43-stereo-throughput.ts` bench — no
H-vs-inverse contradiction surfaced synthetically, so a sign-flipped rig
view now cleanly implicates the homography feeder, not the matcher.
Residual (report-only): invalid pixels carry `minDisparity − 1` ≈ −257,
which drags the heatmap's per-frame auto-min — RESOLVED same day: the
disparity heatmap is pinned to `SIGNED_DISPARITY_HEATMAP_RANGE` (derived
from the window constant), so invalids clamp to the floor color and the
colormap is frame-to-frame stable.

## Problem (user-reported, 2026-07-10)

The SGBM brick produces nothing meaningful. Both attach sites
(`app/modules/disparity-scope/session.ts` free-run node,
`app/modules/multi-fovea/session.ts` paired node) pass **no params**, so the
brick runs at its defaults: `minDisparity = 0`, `numDisparities = 128` — a
0…+128 px one-sided search. With foveated (independently steered) gaze the
true L↔R disparity is SIGNED and gaze-dependent, ranging −W…+W; almost the
entire scene falls outside the searched window and matches as garbage.

## Ruling (2026-07-10)

**Fixed wide symmetric range, applied to BOTH apps.** (Gaze-centered dynamic
retuning and in-brick pre-shifting were considered and declined.)

- Attach params at both sites: `{ numDisparities: 512, minDisparity: −256 }`
  (window −256…+255; the brick rounds `numDisparities` up to a multiple
  of 16). Values are deliberately static — no pose coupling.
- No native change: `StereoStream` already accepts any signed `minDisparity`
  and `retune` remains available if the window ever needs adjusting live.
- Cost note: ~4× the default-window SGBM cost. Acceptable because the brick
  is ON-DEMAND (parked with no consumer) and drop-oldest — an overloaded
  matcher lowers the disparity view's fps, never backpressures the pair/
  convert chain. True ±W coverage is infeasible (cost linear in window) —
  this window covers gaze divergence up to ±256 px; beyond that the view
  degrades again (known limitation, revisit on the rig).

## Downstream

- Heatmap: no change — per-frame min/max auto-normalization already handles
  signed CV_32F input.
- Verify no consumer assumes disparity ≥ 0 (`Disparity32F` readers).

## Verification (software)

- Synthetic end-to-end test: feed known-shift L/R test frames through the
  stereo brick (synthetic pipe producers / `feedTestFrame`) and assert the
  recovered disparity's SIGN and magnitude for both a positive and a negative
  shift — this pins the sign convention and doubles as a regression guard for
  the OPEN stage-f H-vs-inverse homography-orientation question
  (`docs/hardware/stage-f.md` §Disparity Scope), which may compound this bug
  and should be flagged (not fixed) if the test exposes it.
- vitest: session attach params asserted through the fake stereo seam.
- RIG-GATED: real-scene disparity quality at the widened window; SGBM fps
  under load.
