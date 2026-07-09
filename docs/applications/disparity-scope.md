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

## Pipeline (SPLIT-NODE topology, docs/proposals/split-disparity-nodes.md, 2026-07-09)
Session (thin coordinator): acquires the calibrated triple, advertises the
three undistort pipes (C intrinsic; L/R homography, fed by the mirror-history
feeders), then composes the pipeline out of GENERAL-PURPOSE nodes:

- **Slice nodes** (the fovea crop brick under session ids):
  `camera/<C>/undistort/slice/scope-strip` (the target-centered match strip,
  center tile × expand_x/expand_y) and `.../slice/scope-tile` (the display
  center tile) — live-steered (`setFoveaRect`) as the target/zoom move.
- **Scale nodes** (the ScaleStream brick; the match workers do NO resizing):
  `.../scope-strip/scale/match` at reactive `{ratio: s}` and one
  `camera/<L|R>/undistort/scale/scope-needle` per fovea at
  `{dsize: foveaTileSize}` — both sides land at `s` px per wide px (CCOEFF
  matching is not scale-invariant).
- **Two `template-match` vision workers** (`win/disparity-scope/match/L`,
  `/R`): needle = the pre-sized fovea, haystack = the shared pre-sized strip.
  Results carry the strip frame's **crop origin** (forwarded unscaled through
  slice → scale), so `origin + rectCenter/s` is an ABSOLUTE undistorted-wide
  position — no target or drag flag ever rides a worker.
- **The pid node** (`win/disparity-scope/pid`) is the app-specific JOIN: per-
  side results land keyed L/R, the vergence step runs when the arriving side
  completes a seq pair (~once per strip frame), and `stepVergence` →
  commandedVolts → **controller node** position input (`openPosition`, push
  model).

The KCF tracker is unchanged (§3.5): a chained native thread on the C
undistort brick; its output drives the session's target state, which steers
the slice crops. The per-side correlation heatmaps are the only session
frames left (`match_left`/`match_right`).

- **SGBM chain** (stereo-disparity-and-heatmap-nodes, 2026-07-09): the
  session also composes `stereo/scope` (two-input SGBM brick on the L/R
  undistort pipes → F32 disparity) + `stereo/scope/heatmap/view` (TURBO
  colormap → BGRA8). Both stay PARKED until the renderer selects the SGBM
  center view and connects the heatmap pipe — the consumer gate + the
  heatmap→stereo tap propagate demand end to end (no subscriber → no
  compute).

## UI & controls
StreamViews for the wide (undistorted C) view; the guide strip + per-side
match heatmaps moved OFF the main UI into the module's **debugger sub-window**
(`Debugger.vue`, toggled by the button at the bottom of the center column —
disparity-debugger-window.md): a vertical, pixel-column-aligned stack of the
scope-strip SLICE PIPE (with the match/center overlay rects) over the two
match heatmaps, which the match kernel pads to the strip's dims (each heatmap
pixel = the needle CENTERED at that strip pixel). The window is the `debug`
class: exempt from app exclusivity, cascade-closes with the app, passive
subscriber. The CENTER view is ONE pipe-backed StreamView with a four-way
title-slot select (composite-node-and-center-select-fix) — **Wide Angle
Sliced** (the scope-tile slice pipe), **Disparity L-vs-R** and **Anaglyph**
(BOTH the `stereo/composite` CompositeStream brick's pipe; the session
retunes its mode from `state.view` — red = LEFT / cyan = RIGHT), and **SGBM
Disparity** (the stereo heatmap pipe). Only the selected view's pipe is
connected, so unwatched producers park; disparity↔anaglyph flips retune the
same connected pipe (no reconnect).
Verge/baseline/shift parameters; PID tuning; target select (tracker
auto-follow). Dragging on the C view calls the **tracker's override** with the
dragged point (NOT the PID slot) and the foveas **follow the cursor directly**
(direct-follow rulings 2026-07-08/09, `followTarget` in vergence.ts):
pointer-down **resets pan, v_shift and verge**, so both eyes track the RAW
cursor ray IN PARALLEL — **vergence at infinity**, no residual corrections —
the PID does NOT step and the match-score gate does not apply during the drag
(the earlier "PID keeps stepping" semantics could never follow a drag onto
unmatched content: the strip recenters on the dragged target, the match
scores drop, control holds, the foveas never move). The all-zero controller
state equals the follow command, so on release the native tracker re-arms
there and the PID resumes continuously from the parallel pose (first resumed
output == last follow output — no release "jump"), then re-converges every
DOF from scratch. The UI override badge reads the `overridden` telemetry
(the tracker flag).

## Expected behavior
Matching quality visible in match_left/right; disparity/verge numbers steady on
a static scene; PID engage converges foveas onto the target. Drag start may
visibly snap the foveas onto the raw cursor ray (accumulated pan/v_shift
corrections reset); during the drag both foveas track the ray in parallel
(vergence at infinity, status "manual"), regardless of match quality; all
DOF re-converge from scratch on release.

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
- **RESOLVED — secondary (was RIG-GATED, hit on the rig 2026-07-09 as
  "needles way too small"):** `foveaTileSize` sized the tile from the CENTER
  `width/height` while dividing by the MEASURED magnification (a
  fovea-px-per-center-px ratio), adding an uncorrected `foveaRes/centerRes`
  factor whenever the fovea cams out-resolve the center. The session's
  `needleGeometry` now pairs the base dims with the zoom source: fovea dims
  under the measured magnification, center dims under the nominal FOV-ratio
  fallback (the legacy `W_c/z`). RIG-GATED: verify the match rects on the
  debugger strip are fovea-footprint sized.
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
