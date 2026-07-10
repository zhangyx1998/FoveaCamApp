# Channel-order fix — kill the B/R flip at the source

Status: **DIAGNOSED (2026-07-09, empirically proven); fix wave queued
behind the in-flight viewer lane (shares decode.ts).** Supersedes the
prior "preview pipe is BGRA8, don't relabel" ruling — the user ruled the
view-layer compensation must become unnecessary.

## Root cause (single, proven)

`Arv::cvtColorCode` (core/lib/Aravis/PixelFormat.cpp:130-213) maps each
GenICam Bayer format to the SAME-LETTERED OpenCV `COLOR_BayerXX2*`
constant. OpenCV's Bayer enum naming is off-by-one vs the GenICam/PFNC
sensor naming, so the correct constant has R and B swapped:
`BayerRG (RGGB)` must use `COLOR_BayerBG2*` (code uses `RG2*`);
`BayerBG↔RG`, `BayerGR↔GB` likewise. Greens stay on the same diagonal —
it is a PURE R/B swap, **no demosaic phase shift**.

Empirical proof (synthetic pure-red RGGB mosaic through both constants):
code's `COLOR_BayerRG2BGR` puts red in ch0 (physically RGB under a BGR
label); `COLOR_BayerBG2BGR` puts red in ch2 (correct). Full transcript
was produced during diagnosis (session scratchpad br-flip-diagnosis.md);
re-derive with a 4×4 mosaic through cv::demosaicing if ever in doubt.

## Why previews look right today — two wrongs cancel

Convert emits physically-RGBA bytes but the pipe advertises `BGRA8`;
FrameView.vue:178-192 pours the buffer into a Canvas2D `ImageData`
(RGBA-only, no swizzle). Mislabel + no-op = correct colors. The same
double-compensation exists twice more:
- capture-node.ts:603-608 `makeBGR` (off-by-one) + save-time `RGB2BGR`
  (:620/:913) — PNGs correct only because two bugs cancel;
- viewer decode.ts:177 `${bayer}2RGB` — the SAME off-by-one, so recorded
  raw-Bayer channels show R/B swapped vs live previews (latent
  inconsistency visible today).

## Ruled fix (planner-recommended, matches the user's intent)

1. **Fix the enum mapping once**: swap the R↔B letters in `cvtColorCode`
   for all four output families (`2RGB/2BGR/2RGBA/2BGRA`; `2GRAY`
   untouched), and the two JS mirrors (viewer decode.ts bayer code,
   capture makeBGR) — preferably derived from the shared
   docs/schema/pixel-formats.ts registry so the three sites can't drift.
2. **Canonicalize display-bound pipes to honest `RGBA8`** (browser
   canvas/WebGL are RGBA-native → zero hot-path swizzles, FrameView
   unchanged). Lockstep consumer updates, ALL in one wave (a partial land
   inverts the preview):
   - CompositeStream.h:214 anaglyph red channel → ch0 (today it picks
     ch2 = physically blue → wrong eye);
   - HeatmapStream output → RGBA;
   - gray taps (KCF Tracker.cpp:414, Stereo) → `RGBA2GRAY` (template
     match already uses RGBA2GRAY — already physically correct);
   - capture save path → one honest RGBA→BGR for imwrite, delete the
     compensations;
   - pipe adverts (undistort-pipe.ts:76 etc.) → `RGBA8`;
   - viewer decode → honest RGB/RGBA end to end.
   - Unaffected: recorder raw 12p wire payloads (pre-convert),
     Frame.save (raw mosaic).
3. **Risk rails**: channel-order ONLY — no pixel realignment anywhere;
   land source fix + contract change together; rig check = a known
   red object reads red in every surface (live preview, anaglyph L=red
   eye, SGBM unaffected, saved PNG, viewer playback of an OLD recording
   AND a new one).

Old recordings: raw-Bayer payloads are label-only (demosaic happens at
decode) — the fixed viewer decodes them CORRECTLY; no data migration.
