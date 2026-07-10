# Higher-FPS hybrid object tracker (drop-in KCF replacement)

**Status:** CODE-COMPLETE (2026-07-10) — new core node + test + bench + docs
(`50f1d75`). Rig pass owed (stage-f section below). **First session swap
LANDED**: disparity-scope's chained auto-follow tracker now runs
`createChainedHybridTracker` (`bc20269`, drop-in — node id `undistortKcf`
kept), superseding the chained-KCF path in
[controller-node-and-fifo-edges.md §3.5](./controller-node-and-fifo-edges.md).
Remaining session swaps (center-cam tracker) are the planner's, listed at the
end. Multi-target (`createMultiTracker`) stays on GRAY-KCF for now.

**User request (verbatim intent):** "Deliver a solution for higher FPS object
tracking. Consider using a hybrid approach of detection + matching, or propose a
better alternative if you know any. The resulting node should be able to drop-in
replace KCF tracker node."

## Why (the problem with GRAY-KCF on this rig)

Every camera here is monochrome, and the target scenes are the fovea-controlled
needle / small-blob targets on low-texture backgrounds. On OpenCV 4.13.0,
`cv::TrackerKCF` needed two successive pins just to survive at all (GRAY
features + `desc_pca=desc_npca=GRAY, compressed_size=1`, see `Tracker.cpp`), and
even pinned it is **fragile on exactly the rig's hard content**: it locks on the
arm frame and then loses the target for good on a smooth blob / low-texture
patch. It also has **no recovery** — once lost it is silent-forever-lost. And it
is not cheap (~1.0–1.4 ms/update at 48–64 px).

## Chosen algorithm — hybrid MATCH + RE-DETECT (windowed NCC)

The disparity matcher already runs `matchTemplate(TM_CCOEFF_NORMED)` on these
exact scenes and trusts it. The tracker reuses that correlation:

- **Fast path (per frame):** windowed NCC. `matchTemplate(TM_CCOEFF_NORMED)` of
  the target template inside a small search window centered on the last
  position. Window half-extent ≈ `3 × recentDisp` (EMA of per-frame
  displacement), floored so the window is ≥ ~2× the template, capped at 256 px.
  Sub-pixel peak via a parabolic fit on the 3×3 score neighborhood → smooth
  centers. Per-frame `score ≥ trackThresh` → found/lost.
- **Template strategy (drift-proof) — dual template:** an **ANCHOR** captured at
  arm (never mutated) + an **ADAPTIVE** copy (slow EMA, `α=0.05`). Both are
  matched in the window each frame; the reported position is the **argmax of
  max(anchor, adaptive)**. The adaptive copy is blended toward the fresh patch
  **only when the invariant anchor also confirms that location** (its score at
  the chosen loc ≥ track threshold) — so appearance change is absorbed but drift
  onto background is refused.
- **Recovery (the "detection" half):** on a lost frame, an ANCHOR-only search
  progressively widens (2×, 4×, 8× the template) and, past a 6-frame lost
  streak, scans the **full frame at half resolution** (`pyrDown`) to bound cost.
  Re-lock requires clearing a **higher** re-acquire threshold (hysteresis:
  `reacqThresh > trackThresh`) so a marginal frame cannot thrash the lock. On
  re-lock the adaptive copy is reset to the pristine anchor.
- **Single-scale** (rig target scale is fovea-controlled). Scale robustness
  (multi-scale template pyramid) is noted future work.

### Thresholds (validated in the C++ probe, locked here)

| knob | value | role |
|---|---|---|
| `kTrackThresh` | 0.45 | per-frame found gate (CCOEFF_NORMED ∈ [-1,1]) |
| `kReacqThresh` | 0.60 | recovery re-lock gate (> track → hysteresis) |
| `kAdaptAlpha` | 0.05 | adaptive-template EMA rate (anchor-confirmed only) |
| `kMotionMult` | 3.0 | search radius ≈ 3× recent per-frame motion |
| `kFullFrameLostStreak` | 6 | escalate recovery to full-frame half-res |
| `kMaxRadius` | 256 | search-radius cap (px) |

### Why not the alternatives

- **CSRT** — robust on everything but 2–5 ms/update; misses the fps goal as the
  per-frame path. (Could serve as an optional recovery verifier later; not
  needed — anchor NCC recovers in 2 frames in the probe.)
- **Pyramidal LK / median-flow** — good for smooth motion but weak-to-absent
  re-detection and drift-prone on low-texture; NCC re-detect is simpler and
  already proven on this content.

## Bench (pure C++ probe — the ONLY place tracking quality is judged)

The Aravis fake-camera ramp is spatially periodic and gives chaotic
correlation-tracker verdicts, so quality is measured on synthetic **textured**
(deterministic pseudo-random), **blob** (needle-like gaussian on flat bg) and
**lowtex** (faint target on a low-contrast gradient) content, target chip = ROI,
120 frames, M-series machine. `found` = per-frame lock ratio; `err` = mean
center error vs ground truth; `us` = µs/update.
Probe: `scratchpad/hybrid_probe.cpp` (mirrors `HybridCore` exactly).

| scene | roi | motion | HYBRID found / err / µs | KCF-GRAY found / err / µs |
|---|---|---|---|---|
| textured | 32 | 1–4 | **100% / 0.38px / ~117µs** | 100% / 1–4px / ~365µs |
| textured | 64 | 1–8 | **100% / 0.38px / ~420µs** | 100% / 1–9px / ~1355µs |
| textured | 96 | 1–8 | 100% / 0.38px / ~940µs | 100% / 2–9px / ~880µs |
| **blob** | 48 | 1 | **100% / 0.39px / 248µs** | **1% / — / 437µs** |
| **blob** | 64 | 1–8 | **100% / 0.38px / ~418µs** | **1% / — / ~753µs** |
| **blob** | 96 | 1–8 | **100% / 0.38px / ~938µs** | **1% / — / ~539µs** |
| **lowtex** | 32–96 | 1–8 | **100% / 2.8–3.0px / 114–940µs** | **1% / — / 205–540µs** |
| recovery (teleport@f10) | 64 | — | **re-lock in 2 frames** | **NEVER re-locks** |

Reading it:

- **Robustness** — hybrid holds 100% lock on blob and low-texture where GRAY-KCF
  collapses to ~1% (single-frame hit then lost-forever). That is the rig's whole
  hard-case problem, solved.
- **Accuracy** — sub-pixel (0.38 px) on textured/blob; ~2.9 px on the faint
  low-texture target (broad correlation peak — acceptable, still 100% found;
  tightening it is future work).
- **Speed** — faster than KCF at 32/48/64 px (the operating range): 64 px ≈
  420 µs (~2400 fps) vs KCF's ~1355 µs (~740 fps). At 96 px the two dual-template
  matches make hybrid ~940 µs, marginally slower than KCF (~880 µs) — but KCF at
  96 px is already unreliable off textured content. Comfortably clears the
  >200 fps @ 64 px goal with ~10× headroom.
- **Recovery** — hybrid re-acquires 2 frames after a target teleport; KCF never
  does.

## Drop-in surface (AS-BUILT)

All new code is in `core/src/Tracker.cpp` (single TU, no build changes — the
CMake glob picks it up).

- **Refactor (behavior-preserving):** the former monolithic `KcfCore` is split
  into a base **`TrackerCore`** (the arm / override / release / re-arm state
  machine + meter-framed produce loop, verbatim) with two virtual engine hooks
  `engineInit(src, roi) → bool` and `engineUpdate(src) → EngineResult{found,
  bbox, center}`. `KcfCore : TrackerCore` keeps the exact prior KCF behavior
  (GRAY features, 3-ch BGR view, throw-as-lost). **KCF observable behavior is
  unchanged — guarded by tests 12 and 21, both green.** This is why the hybrid
  reuses the state machine rather than reimplementing it.
- **New engine:** `HybridCore : TrackerCore` (the NCC fast path + dual template
  + recovery ladder above). Normalizes input to 8-bit **gray** (Mono8
  passthrough; RGBA8 tap → gray) — NCC wants one channel. Frame data is copied
  into owned templates at arm (survives `Frame::release()`), and all matching is
  synchronous within `step()` before any release (frame-release-timing rule).
- **New nodes (teardown shape copied EXACTLY from the KCF twins):**
  `HybridTrackerStream` (raw, on a camera's shared `Arv::Stream`, latest-wins)
  and `ChainedHybridTrackerStream` (`ChainedStreamOf<TrackResult::Ptr>`, Leaky
  tap, `closeChain()`+`shutdown()` in the dtor — tests 36/38 guard it).
- **NAPI handle reused unchanged:** both new streams are wrapped by the **same**
  `KcfTrackerObject` over the **same** `TrackerHandle` — identical `arm(roi)` /
  `override({x,y})` / `releaseOverride()` / `probe()` / `stall(ms)` /
  `[Symbol.asyncIterator]`, identical `TrackResult` `{found, bbox, center,
  overridden, seq, deviceTimestamp}`, identical meter schema (`ThreadMeter` with
  `frame` input / `track` output) — so the graph badges and `trackerWorkload()`
  adapter work with zero change.
- **New factories:** `Tracker.createHybridTracker(camera, name?)` (default meter
  name `"tracker:center"` — replaces the same node) and
  `Tracker.createChainedHybridTracker(sourcePipeId, name?)` (default
  `"<src>/hybrid"`). Declared in `core/dist/Tracker/index.d.ts`, both returning
  the existing `KcfTracker` interface.

## Tests

- **`core/test/41-hybrid-tracker.ts`** (test-12 harness re-pointed): thread +
  async-generator seam, monotonic seq, in-bounds bbox + finite sub-pixel center,
  meter schema/name parity, `stall → drops` metering, override echoes the
  override center + `overridden:true` (engine skipped), release → re-arm resumes
  non-overridden — on **both** the raw and chained variants. Quality asserts are
  intentionally **not** on the fake camera (periodic ramp); they live in the C++
  probe. **PASS.**
- Regression battery (all **PASS**, exit 0): `12` (KCF unchanged), `21`
  (multi-KCF unchanged), `22` (brick-chain), `36` (close-deadlock), `38`
  (teardown-race), `41` (new).
- Core build: `cd core && PATH="/opt/homebrew/bin:$PATH" make` — clean for both
  node and electron runtimes.

## Session swap plan (planner, later — one line per session)

The hybrid is a pure drop-in; each swap is replacing one factory call and
nothing else (same object, same events):

- **Center-cam tracker session:** `createTracker(camera, name)` →
  `createHybridTracker(camera, name)` (keep the same `name`).
- **Chained tracker session(s)** (disparity / undistort-tap trackers):
  `createChainedTracker(srcId, name)` → `createChainedHybridTracker(srcId,
  name)` (keep the same `name`).
- No consumer changes — `TrackResult`, override/drag, PID vergence, graph badges
  and `trackerWorkload()` all consume the identical shapes.
- Multi-target (`createMultiTracker`) is left on KCF for now; a multi-target
  hybrid (`MAX_TARGETS` × `HybridCore` on one thread) is the obvious follow-up
  and reuses the same engine.

## Stage-F (rig pass owed)

Lock on the REAL hardware before flipping any session default:

- **Lock quality** on the real needle / small-target scenes at the fovea's
  operating ROI — confirm sustained lock where GRAY-KCF flashed-then-lost.
- **Recovery** after real occlusion + fast motion (target leaves the window):
  confirm 2–few-frame re-acquire and that hysteresis prevents lock thrash.
- **FPS headroom** on the free-running wide camera: confirm the tracker sustains
  well above the fovea rate at 48–64 px ROI with the meter showing `drops=0`
  (the probe predicts ~2400 fps @ 64 px; verify on-rig).
- **A/B vs KCF feel:** drag/override latency parity, PID vergence smoothness,
  no visible box jitter (sub-pixel centers should read smoother than KCF).
- **Threshold tune** if real content differs from the synthetic probe: expose
  `kTrackThresh` / `kReacqThresh` first (they are the two that matter).
- **Future work:** multi-scale robustness; tighter low-texture accuracy;
  multi-target hybrid; optional CSRT recovery-verifier.
