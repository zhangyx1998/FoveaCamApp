# Disparity Scope

**Seed confidence: HIGH → CORRECTED by audit (2026-07-08), then FIXED same
day.** The pipeline description held up; the USER-REPORTED "scale ratio
ignored" claim did **not** survive code inspection and is restated below. The
underlying real defect (nominal-zoom-driven match scale) is now FIXED — the
cross-file plumbing was granted and implemented; see "Decision taken".

## Purpose
Stereo vergence tuning/inspection: lock onto a target in the center (wide)
camera, extract a template around it, template-match against the L/R fovea
streams, compute per-tile disparity + a vergence analysis, and drive the mirror
verge via PID so the foveas converge on the target depth.

## Pipeline (post-§3.5, 2026-07-08)
Session (thin coordinator): acquires the calibrated triple, connects
`camera:<L|C|R serial>` pipes (consumer-gate → converter threads run), spawns
the per-session vision worker with the `disparity` kernel
(modules/disparity-scope/vision.ts). The L/R foveas arrive **pre-warped** off
their own `camera/<serial>/undistort` homography pipes and the wide input is the
center camera's `undistort` pipe — the kernel no longer does `wrapPerspective`
and takes no homography params (the undistort bricks own the warp; overlays and
`analyzeVergence` live on the UNDISTORTED C view). The KCF tracker is **off the
matching thread**: the SESSION owns a chained tracker (`createChainedTracker` on
the C undistort brick, own native thread) whose scalar output arrives in the
kernel as the `target` param plus the `overridden` drag flag at result rate.
Worker: slices the target region, builds tiles + `diff` template matching +
`analyzeVergence`; posts scalar analysis + derived DIAGNOSTIC frames
(center.sliced, guide, match_left, match_right; NOT the L/C/R views — those
source directly from the undistort pipes). Main: the per-eye PID node's
`stepVergence` → commandedVolts → **controller node** position input
(`openPosition`, push model; the shared 1 ms actuation loop is deleted).

## UI & controls
StreamViews for the wide (undistorted C) view + sliced/guide/match/disparity
views; verge/baseline/shift parameters; PID tuning; target select (tracker
auto-follow). Dragging on the C view calls the **tracker's override** with the
dragged point (NOT the PID slot): the PID vergence node keeps running throughout,
steering the foveas toward the moving tile; on release the native tracker re-arms
there and the PID continues seamlessly (no release "jump"). The UI override badge
reads the `overridden` telemetry (the tracker flag).

## Expected behavior
Matching quality visible in match_left/right; disparity/verge numbers steady on
a static scene; PID engage converges foveas onto the target. During a drag the
foveas visibly servo toward the dragged tile (status "manual").

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
`zoom` factor cancels between them (invariants pinned in
`app/test/vergence.test.ts`). `wrapPerspective(fovea, A2H)` does **not** rescale
the fovea to wide pixels — `findPinholeProjection` builds A2H to a fovea-native
rectified frame, so the ÷`zoom` step is required and correct.

**The real defect** was the *source* of `zoom`: a nominal session-state constant
(default 9.0, the "Zoom Ratio" input), not the calibrated magnification. CCOEFF
template matching is not scale invariant, so a mis-set nominal zoom put the tile
and strip at different pixel scales and degraded matching.

## Decision taken (2026-07-08, coordinator-granted)

The calibration-MEASURED fovea↔wide magnification now drives the match:

1. **`app/lib/marker.ts` `findPinholeProjection`** returns
   `{ A2H, scale, scale_std }` instead of discarding the measured scale
   (fovea px per object-unit at the protocol's nominal 1000-unit marker
   distance; previously `console.log`-only).
2. **`app/lib/coordinate-conversions.ts`** — `ExtrinsicConversions` carries
   optional `scale`/`scale_std`; new pure `foveaWideMagnification(scale, focal)
   = scale·1000/mean(focal)`, null on missing/degenerate inputs. The derivation
   is unit-independent but assumes extrinsic captures near the protocol's
   nominal 1000-unit distance — the same assumption `findPinholeProjection`'s
   hardcoded projection plane already bakes into A2H. RIG-GATED: check the
   reported value lands near the known optics (~9x) on real calibration data.
3. **`app/orchestrator/calibration.ts`** — `CalibratedTriple.magnification:
   { L, R }` (per-eye measured ratio or null), built in
   `leaseCalibratedTriple`.
4. **`app/modules/disparity-scope/session.ts`** — ships `matchZoom` (mean of
   the per-eye values; single eye's value if only one measured; null if none)
   to the kernel; `effectiveScale()` folds `tuning.scale` against the measured
   magnification. A single scalar is used because the match shares one guide
   strip + one tile size for both eyes; the two foveas share optics so L/R
   should agree (the mean absorbs measurement noise).
5. **`app/modules/disparity-scope/vision.ts`** — new `matchZoom` param; the
   tile size and `analyzeVergence` use `matchMagnification(matchZoom, zoom)`
   (vergence.ts): measured when valid, else `max(1, zoom)`.
6. **Telemetry `match_magnification`** (contract.ts) surfaces the active
   measured value (null = fallback); the UI's "Template Scale" readout and the
   Zoom-Ratio tooltip use it.

**FALLBACK (zero regression on old data):** when no measured value exists —
legacy extrinsic fits without `scale`, uncalibrated wide camera, degenerate
values — `matchMagnification` falls back to `max(1, state.zoom)`, byte-for-byte
the previous behavior.

**Knob semantics now (PROMINENT — user may veto, see Open questions):**
`state.zoom` ("Zoom Ratio") drives ONLY the sliced-view crop size (and remains
the match fallback on unmeasured rigs). On calibrated rigs the knob **no longer
influences template matching at all** — the measured value wins unconditionally.

Selection + derivation are unit-tested (`app/test/vergence.test.ts`:
`foveaWideMagnification`, `matchMagnification`, plus the tile/strip
scale-consistency invariants).

## Known/suspected issues
- **RESOLVED — bug (a):** match scale now comes from the calibration-measured
  magnification (nominal-zoom fallback). RIG-GATED: verify match_left/right
  quality improves (or at minimum, `match_magnification` telemetry reads a
  plausible ~9x) on the calibrated rig.
- Secondary (RIG-GATED): if the fovea camera's native resolution differs from
  the center camera's, `foveaTileSize` uses the CENTER `width/height` to size the
  fovea tile, adding an uncorrected `foveaRes/centerRes` factor. Harmless when
  all three cameras are the same model/resolution (expected for FoveaCam Duo);
  worth confirming on the rig.
- `analyzeVergence` inputs verified scale-consistent: the guide strip, the tile
  grid, and `center.rect` all resolve in the same wide-frame-pixel space that
  `stepVergence` lifts to angles via `P2A.C`. No additional ratio needed there.

## Open questions (for the user)
1. **Veto point — should the Zoom-Ratio knob influence matching at all?** The
   implemented choice: NO on calibrated rigs (measured value wins; knob is
   crop-only + fallback). Alternatives if vetoed: (a) knob acts as a manual
   multiplier/trim on the measured value; (b) knob default is *seeded* from the
   measured value but stays user-editable and authoritative. The tooltip on the
   knob and the `match_magnification` telemetry make the active behavior
   visible either way.
2. **Per-eye magnification.** L and R are measured independently and averaged
   for the single match scale. If the two fovea paths ever diverge optically,
   the match/tile pipeline would need per-eye tile+strip sizing — worth it?
   (Current hardware: shared optics, expected to agree.)
3. **Distance assumption.** `foveaWideMagnification` inherits the extrinsic
   protocol's nominal-1000-unit capture-distance assumption (already baked into
   A2H). If future calibration captures at varying distances, the measured
   `scale` (and A2H) would both need a per-pose distance term — flag for the
   calibration owner rather than this module.
