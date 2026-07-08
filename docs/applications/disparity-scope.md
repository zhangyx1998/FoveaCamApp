# Disparity Scope

**Seed confidence: HIGH (planner worked this app through real-1f/1g).**

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

## Known/suspected issues
- **USER-REPORTED: fovea↔wide scale ratio ignored in template matching** — the
  template sliced from the WIDE view is matched against FOVEA frames as if they
  share pixel scale. Foveas are magnified crops (mirror-steered, different
  optics/zoom); the template (or the fovea) must be rescaled by the actual
  magnification ratio (derivable from calibration/`deriveFoveaIntrinsics` or
  the projection homography) before diff-matching. Fix the math; if the correct
  ratio source is ambiguous, present options to the user.
- Suspected: tile grid + search window sized in wide-pixels may also need the
  ratio; verify `analyzeVergence` inputs are scale-consistent.

## Open questions (for the user)
(auditor fills)
