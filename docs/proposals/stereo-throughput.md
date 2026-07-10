# Stereo disparity throughput — algorithm selection toward ~60 fps

Status: **PROPOSED (ruled 2026-07-10).** Companion to
[`sgbm-signed-range.md`](./sgbm-signed-range.md) (the signed ±256 window
ruling stands regardless of algorithm choice; both land in the same wave).

## Problem (user-reported, 2026-07-10)

The stereo brick runs ~1 fps and must approach the ~60 fps camera rate. The
wide fixed disparity window (512 units, per the signed-range ruling) worsens
cost ~4×; the user has ruled that a pose-derived/dynamic window is NOT
viable — the window is a fixed reality to optimize around.

## Rulings (2026-07-10)

1. **The matcher is not sacred.** SGBM may be swapped for any more efficient
   algorithm as long as output disparity quality stays decent.
2. Portability bound: must run CPU-side on BOTH Linux (lab PC) and the M1 Max
   macOS rig — no CUDA, no heavyweight NN inference runtime.

## Approach — benchmark-driven selection behind the existing brick

Keep the `StereoStream` brick's contract (two BGRA inputs / paired records →
`Disparity32F` left-coords pipe, reactive params, on-demand gate, meter)
and make the MATCHER a selectable strategy. Candidates to implement and
measure (all OpenCV-portable):

| Candidate | Sketch | Expected |
|---|---|---|
| A. Scaled SGBM_3WAY | match at 1/s (default s=4), window 512/s, upscale values ×s | ~40–60 fps, smooth maps |
| B. Scaled StereoBM (+prefilter) | BM at 1/2 or 1/4 + speckle filter | fastest CPU classic, weaker on low texture |
| C. A or B + WLS guided refine | `cv::ximgproc::DisparityWLSFilter` guided by full-res left frame | recovers edge quality from scaled match at modest cost |

New reactive params (superset of today's): `algorithm` ("sgbm" | "bm"),
`mode` ("sgbm" | "3way" | "hh"), `matchScale` (1/2/4, default from the bench
winner), `wls` (bool + lambda/sigma), plus the existing
`numDisparities`/`minDisparity`/`blockSize` — all live-retunable; d.ts and
`StereoParams` (app/orchestrator/stereo-pipe.ts) extended to match.

Output semantics: disparity VALUES always in full-res left-frame pixel units
(scaled matching multiplies back); map DIMENSIONS may be emitted at match
scale (heatmap auto-normalizes and the renderer upscales visually) — the
advert carries the actual dims, consumers must not assume full-res.

## Benchmark (hardware-free, runs on the lab PC)

A numbered `core/test/` script driving the brick with synthetic textured
stereo frames (known planar ground-truth disparities across the ±256 range,
camera-res dims):

- Per candidate/param set: fps (steady-state over ≥100 frames), and quality =
  fraction of valid pixels within ±2 px of ground truth + invalid-pixel rate.
- Selection gate: highest-quality candidate meeting ≥55 fps at camera res.
  Record the full result table in the report; default the brick to the
  winner; the losers remain selectable via `algorithm`/`mode` params.
- Quality is finally judged on the RIG (real scenes) — the parameter surface
  exists precisely so it can be retuned there without native rebuilds.

## Non-goals

- No CUDA/OpenCL path, no NN stereo (portability ruling).
- No change to the pairing topology, on-demand gating, or output pipe
  contract beyond dims-at-match-scale.
- The ±256 signed window default is not revisited here.

## Verification

- The benchmark doubles as the regression test (sign convention + quality
  gate + throughput floor asserted).
- vitest: extended `StereoParams` plumbing through the seam; both sessions
  attach with the signed-window params from `sgbm-signed-range.md`.
- vue-tsc, boundary greps; RIG-GATED: real-scene quality + fps.
