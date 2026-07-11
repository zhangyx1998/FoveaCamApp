# Calibration review — 2026-07-11 (4 parallel reviewers, adversarially verified)

User-requested thorough review of intrinsic + extrinsic calibration at origin
HEAD (post-pull, incl. the clarity-sweep session — diff-verified comment-only
on all audited files). Four reviewers: intrinsic subsystem, extrinsic
subsystem, architecture/store alignment, math/precision. 156+132+103 related
tests all pass; every finding below carries file:line evidence personally
confirmed by its reviewer. Status: **AWAITING RULING** on the fix wave.

## Answers to the four questions

1. **Thread-node alignment: mostly yes, one real violation.** The intrinsic
   checker path is the model citizen (worker + pipe + port). VIOLATION:
   `MarkerTracker.fitSubPix` (app/orchestrator/marker-tracker.ts:108-133)
   runs per-tick synchronous full-frame `gaussian` + up to 3× RANSAC
   `findHomography` ON the orchestrator loop — worst in calibrate-extrinsic
   (three live trackers); the wide-camera blur result is never used. Plus
   profiler-visibility gaps: checker kernel + marker-detector threads are
   metered but graph-invisible (no node registration, unnamed threads, no
   roles map) — disparity-scope registers all of these explicitly.
2. **Store architecture: fully integrated.** All reads/writes on records v2
   (per-kind dirs, 32-hex content-hash ids) through MAIN's authority;
   wireEncode verified on every hop; zero pre-v2 writers; migrations cover
   every legacy layout; remaining legacy readers are the ruled read-only
   fallbacks. (Doc drift only: sessions.md §3 still narrates the old
   orchestrator-owned store.)
3. **Legacy file writes: none.** Every fs mutation in both apps' import
   closures is sanctioned (user-chosen capture/recording output, the
   authority's own primitives, janitor state). Camera-config is store-backed,
   read-only from intrinsic.
4. **Math: fundamentally sound, with two real bugs in the depth path and
   several precision/quality gaps.** Positive assurance: double precision
   from solve → store → Undistort (no float32 truncation of the camera
   matrix); A2P/P2A exact inverses with consistent conventions; drift
   anti-symmetric; vergence algebra exact (`seedVergence` inverts
   `inverseTriangulate`); the H-vs-inverse question RESOLVED as
   self-consistent (H fit observed→canonical, applied forward in both
   consumers — the rig question is only whether the fit target is the
   desired output frame); quarter-res Q scaling proof correct; SVD solve on
   the design matrix (not normal equations).

## Ranked defects (cross-review, deduped)

| # | sev | finding | anchor |
|---|-----|---------|--------|
| 1 | HIGH | Marker Dictionary selector INERT — no binding/emit; dictionary silently pinned to 4X4_50; the manual's AprilTag workflow yields zero detections, no error | dictionary-selector.ts:40 |
| 2 | HIGH | `leaseCalibratedTriple` leaks all 3 camera leases when the conversion fit throws — and a fresh/uncalibrated rig ALWAYS throws; 5 consumer modules affected until force-release/restart | calibration.ts:250 |
| 3 | HIGH | Depth path doubly broken: `createQMatrix` principal-point sign (`p = (L.c.x−R.c.x)·b`, OpenCV wants R−L) → negative depth at/beyond fixation; AND StereoBM CV_16S fed to reprojectImageTo3D without ÷16 → 16× compressed. Persisted capture metadata `meta.fovea.Q` inherits the wrong Q | stereo.ts:48; display-kernel.ts:141 |
| 4 | HIGH | `calibrateNow` re-reads mutable state after multi-second awaits — mid-solve camera switch persists camera A's intrinsics AS CAMERA B's record (store corruption); solve not covered by busy() | calibrate-intrinsic/session.ts:440 |
| 5 | HIGH | `select()` lacks the supersede guard single-capture has — double-select or close during the 5 s lease retry overwrites/orphans a CameraLease; camera wedged until restart | calibrate-intrinsic/session.ts:325 |
| 6 | HIGH | Extrinsic `confirm` reachable with zero/unfittable records (FIN not gated, `?step=FIN` URL seed); empty latest record SHADOWS older good ones (resolver picks latest-by-created, falls back to legacy not next-newest) | calibrate-extrinsic/session.ts:386; calibration-records.ts:427 |
| 7 | HIGH | fitSubPix per-tick sync full-frame gaussian + 3× RANSAC on the orchestrator loop; wide-camera blur unused (thread-node violation, Q1) | marker-tracker.ts:108 |
| 8 | MED | MarkerDetector at scale 1.0 normalizes the LIVE shared Mono8 frame buffer in place — data race + visible corruption of concurrent preview/recording/capture (found independently by two reviewers) | MarkerDetector.cpp:185 |
| 9 | MED | Extrinsic capture pairs newest streamed volts with an older frame's detection — no settle gate, ignores the mirror-history ring built for exactly this; silent A2V outliers (worse at 600 Hz) | calibrate-extrinsic/session.ts:317 |
| 10 | MED | Extrinsic teardown defer order finalizes recordings AFTER leases release (LIFO order contradicts spec + comment); calibrate-distortion does it right | calibrate-extrinsic/session.ts:206 |
| 11 | MED | Partial checkerboard detections capturable (findChessboardCorners boolean discarded; kernel treats any corners as detection) → whole solve rejects with an opaque count-mismatch | Vision.cpp:418; vision.ts:60 |
| 12 | MED | Camera loss mid-detection is a silent dead end in both apps (frozen detections stay capturable in extrinsic; 0.0 Hz forever in intrinsic; no fail/report) | marker-tracker.ts:145; vision-worker.ts:280 |
| 13 | MED | Degenerate solves unguarded: 1-record intrinsic solve persists plausible garbage; zero-sample marker records committable; calibrateCamera epsilon 0.01 (vs OpenCV's DBL_EPSILON) can freeze dist coeffs early; k3 free with few boards | session.ts / Vision.cpp:458 |
| 14 | MED | Extrinsic fit quality invisible: <10 poses → SVD minimum-norm silently plausible; no residual/R² API or surfacing; silent extrapolation outside the sampled hull (incl. the 200 Hz homography feeder) | calibration.ts:117; Regression.cpp:51 |
| 15 | MED | Failed intrinsic lease freezes "Leasing camera" overlay with no fail() (triple path does this right); checker kernel + detector threads graph-invisible | session.ts:334; marker-tracker.ts:153 |
| 16 | LOW | vergenceToDistance small-angle form (+4% at 500 mm) vs the exact algebra used elsewhere — display-only bias; index-addressed removeRecord; restartDetection stale latestChecker; multi-window unmount deselects for all; scale slider wipes records unnecessarily; picker never re-enumerates; TripleConfig drift type lies (number vs Point2d) so the drift flag never shows; store codec ignores byteOffset (latent); multi-fovea hardcoded baseline/distance in center steer; depthFromProjection Inf/NaN edge handling; bilinear-vs-projective marker centers (self-corrected in intrinsic; small tilt noise in extrinsic) | various |

## Recommended fix wave (pending ruling)

Wave 1 (correctness, S/M each): #1 selector binding; #2 try/finally lease
release; #3 Q sign + ÷16; #4 snapshot-before-await + busy over solve; #5
supersede guard (copy single-capture's); #6 gate confirm + skip-empty
resolver; #8 normalize into a distinct Mat.
Wave 2 (quality/robustness): #7 move fitSubPix work into the vision-worker
substrate (+ drop the unused wide blur — a one-line win immediately); #9
mirror-history-aligned capture; #10 defer reorder; #11 gate on
corners.length === W*H; #12 stall detection → fail; #13 min-records gate +
epsilon 1e-9 + consider FIX_K3; #14 residual surfacing + min-sample gate +
coverage indicator; #15 fail() on lease failure + graph registration.
