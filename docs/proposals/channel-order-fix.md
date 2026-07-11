# Channel-order fix — kill the B/R flip at the source

Status: **CODE-COMPLETE (2026-07-09) — landed as ONE lockstep wave; rig
pass owed (stage-f §Channel-order fix).** Supersedes the prior "preview
pipe is BGRA8, don't relabel" ruling — the view-layer compensation is now
unnecessary; display pipes are honest `RGBA8` end to end.

::: details Root cause: OpenCV Bayer enum off-by-one vs PFNC, and the two-wrongs-cancel display path
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
:::

::: details Ruled fix plan (pre-ship — see AS-SHIPPED below for what actually landed)

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
:::

## AS-SHIPPED (2026-07-09)

Single-source the swap: `docs/schema/pixel-formats.ts` gained `cvBayerPrefix`
(the OpenCV↔PFNC R/B correction) + a generated `FOVEA_BAYER_CV_FORMATS(X)` macro
(`generate-pixel-formats.ts` → `PixelFormat.gen.h`). All THREE demosaic sites
now derive from it and can't drift: C++ `cvtColorCode` (Bayer families expand the
macro), viewer `decode.ts` `bayerCode`, and capture `makeRGBA` (map injected into
the eval'd worker at build time). `pixel_formats.py` regenerated (identical — no
`cvBayer` column added to python; the schema.py wrapping-guard still blocks a full
generator run, so schema.py was NOT re-emitted — unrelated to this change).

Physical byte order: `ConverterStream` target = the advert `pixelFormat`, so
flipping every display advert `BGRA8 → RGBA8` (registry / undistort / slice /
scale / heatmap / composite / fovea) makes the converter emit HONEST RGBA; the
enum fix makes `cvtColorCode(Bayer, RGBA8)` land red in ch0. Consumers, one wave:
CompositeStream anaglyph red → ch0; HeatmapStream `BGR2RGBA`; StereoStream +
Tracker gray taps `RGBA2GRAY` (template-match already was); calibrate-intrinsic
checker tap `RGBA2GRAY`; PairStream + all core `frameType`/output tags `RGBA8`;
`canViewAs` probe `RGBA8`. Capture: deleted `makeBGR` off-by-one + the
compensating `RGBA2BGRA`, replaced with honest `makeRGBA` (held resource) + one
`toSaveBGR` (`RGBA→BGR`) at imwrite. FrameView UNCHANGED (RGBA-native canvas,
verified no-op for 4-channel).

Untouched (as ruled): recorder raw 12p wire payloads, `Frame.save` (raw mosaic),
`Frame.view()` default (explicit-format API, production callers pass Mono8).
Left as latent (out of scope, flagged): `app/lib/imgproc.ts` `makeBGR/makeBGRA`
carry the OLD off-by-one but are DEAD (no importers) — a follow-up sweep should
delete or fix them. pyfcap does NOT demosaic Bayer, so no python decode change.

Tests: `37-bayer-channel-order.ts` (core) demosaics a synthetic pure-red RGGB
mosaic and pins that the registry constant lands red in ch0 while the literal
PFNC name lands it in ch2; `pixel-formats-codegen.test.ts` pins the generated
macro == `cvBayerPrefix`; `decode-conformance.test.ts` pins `bayerCode` applies
the swap; core 26/27 updated to the honest RGBA channel semantics; all display
adverts in the app/core tests flipped to `RGBA8`.

Gates: `core && make` clean; core tests 11/12/15/18/20/22/23/25/26/27/34 + new
37 pass; `vue-tsc` clean; `vitest` 687 pass / 0 fail; `vite build` clean.
