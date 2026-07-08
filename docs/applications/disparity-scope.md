# Disparity Scope

**Seed confidence: HIGH → CORRECTED by audit (2026-07-08).** The pipeline
description held up; the USER-REPORTED "scale ratio ignored" claim did **not**
survive code inspection and is restated below. No in-module code fix was made
for bug (a) — the correct fix is cross-file and is FLAGGED for the planner.

## Purpose
Stereo vergence tuning/inspection: lock onto a target in the center (wide)
camera, extract a template around it, template-match against the L/R fovea
streams, compute per-tile disparity + a vergence analysis, and drive the mirror
verge via PID so the foveas converge on the target depth.

## Pipeline (post-real-1g)
Session (thin coordinator): acquires the calibrated triple, connects
`camera:<L|C|R serial>` pipes (consumer-gate → converter threads run), spawns
the per-session vision worker with the `disparity` kernel
(modules/disparity-scope/vision.ts). Worker: KCF auto-follow on C (core KCF,
synchronous), slices the target region, `wrapPerspective` L/R foveas using
MAIN-COMPUTED homographies (shipped per volt-update), builds tiles + `diff`
template matching + `analyzeVergence`; posts scalar analysis + derived frames
(C, center.sliced, guide, match_left, match_right). Main: `stepVergence`/PIDs →
commandedVolts → shared actuation loop (fire-and-forget CMD_STREAM). Wide
preview = raw `camera:<C>` pipe by design (disparity works in raw center space).

## UI & controls
StreamViews for the wide view + sliced/guide/match/disparity views; verge/
baseline/shift parameters; PID tuning; target select (KCF auto-follow).

## Expected behavior
Matching quality visible in match_left/right; disparity/verge numbers steady on
a static scene; PID engage converges foveas onto the target.

## The fovea↔wide scale math (audit finding — corrects the seed's bug (a))

The seed said the fovea and wide views are matched "as if they share pixel
scale — the magnification ratio is ignored." **That is not what the code does.**
The magnification ratio *is* applied, identically to both sides of the match:

- The fovea tile is resized by `foveaTileSize()` (vergence.ts) to
  `{ width·scale/zoom, height·scale/zoom }`. Since the wrapped fovea frame
  spans `width/zoom` wide-frame pixels of world (its FOV is the wide FOV ÷
  `zoom`), this puts the tile at `scale` strip-px per wide-px.
- The wide guide strip (`getMatchTile`) takes a `(width/zoom)·expand_x` wide-px
  region and downsamples it by `scale` — also `scale` strip-px per wide-px.

So both the fovea tile and the strip land at the same pixels-per-angle, and the
`zoom` factor cancels between them (see the two invariants in
`app/test/vergence.test.ts` → `foveaTileSize (fovea↔wide match scale-
consistency)`, added by this audit). `wrapPerspective(fovea, A2H)` does **not**
rescale the fovea to wide pixels — `findPinholeProjection` builds A2H to a
fovea-native (calibration `scale` px/mm) rectified frame, so the ÷`zoom` step is
required and correct.

**The real defect** is the *source* of `zoom`. It is a plain session-state
constant (`state.zoom`, default **9.0**), edited by the "Zoom Ratio" number
input — a *nominal* magnification, not the calibrated one. The template match is
self-consistent for any `zoom`, but CCOEFF template matching is **not** scale
invariant, so when the real fovea/wide optical magnification differs from the
hand-set 9.0 the fovea tile and the wide strip sit at different pixel scales and
match quality degrades (worst near the frame edges / with a mis-set zoom).

The calibration **already measures** the true magnification and then throws it
away: `findPinholeProjection` (`app/lib/marker.ts`) computes
`scale = √(area(img_pts)/area(relative))` per pose (mean + `scale_std`), which is
the fovea's px-per-mm-at-1000mm; combined with the wide focal `U.focal` the
fovea/wide ratio is `scale·1000/U.focal`. This is only `console.log`ged today.

### Recommended fix — CROSS-FILE, FLAGGED (not done in this lane)
Plumb the measured magnification out so the match uses it instead of the nominal
`state.zoom`:
1. `app/lib/marker.ts` `findPinholeProjection` — return the measured `scale`
   (and/or the derived fovea/wide ratio) alongside the A2H regression.
2. `app/lib/coordinate-conversions.ts` / `app/orchestrator/calibration.ts` —
   carry it onto `CalibratedTriple` (e.g. `conv.magnification.L/R` or a scalar).
3. `app/modules/disparity-scope/session.ts` `initParams()`/watchers — pass the
   calibrated magnification to the kernel as the tile/strip `zoom` (keep
   `state.zoom` for the *sliced-view crop + KCF search-window* sizing, which is
   a UI convenience, distinct from the optical match scale).

All three files are outside this auditor's lane (`app/lib/*`,
`app/orchestrator/*`), so this is reported rather than applied. The alternative
ratio sources considered are in Open questions.

## Known/suspected issues
- **RESOLVED (restated) — bug (a):** the magnification ratio is NOT ignored; it
  is applied via `state.zoom` on both sides of the match (verified + pinned by
  unit test). The genuine problem is that `zoom` is a nominal constant, not the
  calibration-measured magnification (see the section above). Fix is cross-file
  and FLAGGED.
- Secondary (RIG-GATED): if the fovea camera's native resolution differs from
  the center camera's, `foveaTileSize` uses the CENTER `width/height` to size the
  fovea tile, adding an uncorrected `foveaRes/centerRes` factor. Harmless when
  all three cameras are the same model/resolution (expected for FoveaCam Duo);
  worth confirming on the rig.
- `analyzeVergence` inputs verified scale-consistent: the guide strip, the tile
  grid, and `center.rect` (the target footprint, `w1/s = width/zoom`) all resolve
  in the same wide-frame-pixel space that `stepVergence` lifts to angles via
  `P2A.C`. No additional ratio needed there.

## Open questions (for the user)
1. **Which magnification source should drive the match?** Options:
   (a) the calibration-measured per-pose `scale` from `findPinholeProjection`
   (most defensible — it's an independent optical measurement; needs the
   cross-file plumbing above);
   (b) keep the user-set `state.zoom` but seed its default from that measured
   value at acquire instead of the hard-coded 9.0;
   (c) leave `state.zoom` as a manual knob and just document that it must be set
   to the true optical magnification for matching to work.
   Recommendation: (a), falling back to (b) if a single scalar per eye is
   preferred over per-pose. Please confirm before the cross-file change is made.
2. **Should the "Zoom Ratio" input keep controlling the match scale at all?**
   Today one control conflates two roles: the optical match magnification and the
   sliced-view crop / KCF search-window size. If the match uses the calibrated
   magnification (option a/b), should the UI `zoom` keep only the crop/search
   role, or be removed entirely?
