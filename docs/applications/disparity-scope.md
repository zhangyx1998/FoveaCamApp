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
  `camera/<L|R>/convert/scale/scope-needle` per fovea at
  `{dsize: foveaTileSize}` — both sides land at `s` px per wide px (CCOEFF
  matching is not scale-invariant). The needle source is the **raw fovea
  CONVERT pipe**, NOT the homography-undistort pipe: the warp already lands
  the fovea at wide density, so feeding it to `foveaTileSize` (which divides
  by the magnification too) demagnifies TWICE (≈9× linear / 81× area too
  small — the round-2 too-small-needle defect). The raw convert pipe fills
  the frame at fovea-native resolution, so `foveaTileSize` is the single,
  correct ÷magnification (legacy `getFoveaTile` semantics).
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

## Match zoom — RULED precedence + measured magnification (2026-07-09)

The 2026-07-08 attempt above (measured value wins unconditionally) was RETIRED:
its measured value came from `foveaWideMagnification = scale·1000/focal`, whose
"marker sat 1000 marker-side-lengths from the camera" assumption is **false on
the rig** (the marker was ~62–69 side-lengths away), inflating the measured
magnification to ~145–150 vs the true ~9 and commanding a ~16× too-small
needle. The formula is unsalvageable (the dataset can't recover the true
distance) and is **deleted**. The current design:

**Precedence flip (ruling 1).** `matchMagnification(measured, nominalZoom)`
(vergence.ts): an explicit `state.zoom > 0` is **authoritative** — it drives
both the template match AND the sliced-view crop / KCF search sizing. A zoom of
`0` is the new **"Auto"** state → use the calibration-MEASURED magnification
when valid, else `1` (degenerate but honest; the operator then sets a zoom).
The session's crop/KCF sites route through `Math.max(1, matchZoom())` so Auto
crops at the measured magnification instead of degenerating to full-frame. The
UI's `match_zoom` computed and the Zoom-Ratio input (which now accepts `0`,
showing "Auto N×") mirror this exactly.

**New measured magnification — distance/size-free marker-quad ratio (rulings
2 & 3).** Recorded at extrinsic CAPTURE, derived at fit with no distance term:

- *Preferred (ruling 3):* `sqrt(area(foveaQuad) / area(wide_side_marker_quad))`
  — the wide (C) camera usually also sees the SIDE markers the L/R foveae
  track. Same physical marker in both cameras ⇒ its size and distance cancel;
  the area ratio's square root is the linear magnification directly.
- *Fallback (ruling 2):* `sqrt(area(foveaQuad) / area(wide_center_quad)) ×
  (center_mm / side_mm)`. The center and side markers are sized independently
  in the TeleCanvas (`cal_marker_size_mm` × `cal_marker_ratio`), so the
  fallback must carry the marker sizes (recorded per capture). Skipped without
  that metadata.
- *Legacy datasets* (no wide-camera marker quads) → NO measured magnification;
  Auto then falls back to 1.

Plumbing: `calibrate-extrinsic` `capture()` records `C.side_pts` (the wide
camera's side-marker quads, by id) + `C.marker` (sizes at capture);
`createDataSet` threads `wide_img_points`/`wide_center_points`/`marker` per eye
onto `ExtrinsicData`; `findPinholeProjection` computes `magnification` (mean)
`magnification_std` (spread) via `fitMagnification`/`recordMagnification`
(`app/lib/coordinate-conversions.ts`, pure — injected `area` for testability);
`leaseCalibratedTriple` populates `triple.magnification.{L,R}` from the fit;
`session.measuredMatchZoom()` means the two eyes; telemetry
`match_magnification` surfaces it for the UI's Auto readout.

Precedence + derivation are unit-tested (`app/test/vergence.test.ts`:
`matchMagnification`, `recordMagnification`, `fitMagnification`, plus the
tile/strip scale-consistency invariants; `app/test/extrinsic-dataset.test.ts`:
`createDataSet` field threading).

## Known/suspected issues
- **RESOLVED — bug (a) (amended 2026-07-09):** the `scale·1000/focal` measured
  magnification was retired (false distance assumption inflated it ~16×).
  Explicit `state.zoom` is now authoritative; `zoom=0` Auto uses the new
  marker-quad-ratio magnification. RIG-GATED (stage-f §Match magnification
  fix): with zoom=9 the size-trace shows needle dsize ≈160×120; zoom=0 Auto on
  a fresh extrinsic calibration reads `match_magnification` ≈9.
- **RESOLVED — secondary (was RIG-GATED, hit on the rig 2026-07-09 as
  "needles way too small"):** `foveaTileSize` sized the tile from the CENTER
  `width/height` while dividing by the MEASURED magnification (a
  fovea-px-per-center-px ratio), adding an uncorrected `foveaRes/centerRes`
  factor whenever the fovea cams out-resolve the center. The session's
  `needleGeometry` now pairs the base dims with the zoom source: fovea dims
  under the measured magnification, center dims under the nominal FOV-ratio
  fallback (the legacy `W_c/z`). RIG-GATED: verify the match rects on the
  debugger strip are fovea-footprint sized.
- **RESOLVED — round 2 (user-confirmed after 8bdd5b6, "needles STILL far too
  small — ≈9× linear / 81× area"):** the needle scaler's SOURCE was the L/R
  **homography-undistort** pipe. That warp lands the fovea at WIDE pixel
  density (it has already divided by the magnification once); `foveaTileSize`
  then divides by it a SECOND time → the ≈81× area shrink. The strip has no
  such division (it is native center imagery scaled to `s`), so the defect is
  needle-only. Fix (session `needleSources`): feed the needle scalers from the
  **raw fovea CONVERT pipe** (`camera/<L|R>/convert`) — full fovea FOV filling
  the frame at fovea-native resolution — so `foveaTileSize` is the single,
  correct ÷magnification (legacy `getFoveaTile` semantics). `foveaTileSize` +
  `needleGeometry` are UNCHANGED (they were correct for a frame-filling
  source; only the source was wrong). The warped undistort pipes stay the
  stereo/composite source (`warpedSources`) — those bricks want the wide-
  aligned warp. RIG-GATED: verify the debugger needle now renders the
  fovea view at the strip's pixel scale (not a ~1/9 sub-tile), and that
  match_left/right scores recover.
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
3. **Distance assumption — RESOLVED for magnification.** The retired
   `foveaWideMagnification` inherited the protocol's nominal-1000-unit
   capture-distance assumption; the new marker-quad ratio has **no** distance
   term (same marker in both cameras, or explicit marker sizes). The A2H
   homography still uses the `transformPoints(..., 1000)` projection plane —
   unrelated to the magnification now, but flag for the calibration owner if
   future captures vary distance.
