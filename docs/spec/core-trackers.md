# core trackers (KCF)

Behavior spec for the OpenCV tracker configuration in `core/src/Tracker.cpp`
(`makeKcf`, `asColor8`). These are load-bearing traps on OpenCV 4.13.0. The code
carries `// spec:` pointers.

## kcf-gray {#kcf-gray}

`cv::TrackerKCF::Params` — BOTH knobs are required:

1. **GRAY features, not the default CN (Color Names).** Every camera here is
   monochrome, so KCF only ever sees gray-replicated pixels. CN maps those into a
   handful of achromatic color-name bins — on low-texture patches (the rig's
   needle/target scenes, or ANY smooth gradient at the disparity kernel's 64×64
   arm size) the compressed CN response is degenerate: KCF finds the target once
   (frame 2's patch still equals the model) and then NEVER again. Symptom: the box
   flashes once or never locks, UI parks on "armed". GRAY features track these
   scenes reliably.
2. **`desc_pca = GRAY` AND `desc_npca = GRAY`, `compressed_size = 1`.** The obvious
   GRAY-only configs are BROKEN in 4.13.0 — `{pca=GRAY, npca=0}` and
   `{pca=0, npca=GRAY}` both throw "Matrix operand is an empty matrix" on the
   second `update()` (same empty-response bug family as CN-on-1ch). Listing GRAY on
   BOTH descriptor slots with `compressed_size=1` is the config that survives;
   verified 29/29 sustained on 1ch AND 3ch input.

## ascolor8 {#ascolor8}

`asColor8` normalizes any tracker source frame to the 1-or-3-channel 8-bit layout
`cv::TrackerKCF` accepts, reusing the caller's buffer. 1ch passthrough would
suffice for the GRAY features `makeKcf` pins, but the 4-channel chained tap MUST
be reduced (KCF's gray extractor mishandles 4ch), and replicating 1ch → BGR keeps
every variant on one proven path. Callers feed 8-bit frames (center cam is Mono8;
the chained tap is RGBA8).
