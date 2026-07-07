# HIL findings — 2026-07-07 rig session

Findings from the hardware-in-loop pass on the wave-4 optimization baseline
(commit `87013cd`). Split into **UI defects** (fix later, A-owned, need live-UI
verification) and **perf/architecture** findings (folded into the refactor;
design direction lives in planner auto-memory + the forthcoming refactor plan).

## UI defects — fix later (A-owned)

### UI-1 — Title bar disappears in full screen
- **Where:** `app/src/components/TitleBar.vue`.
- **Symptom:** the title bar vanishes on entering full screen.
- **Root cause:** the bar height is derived from the Window Controls Overlay
  rect — `height = (rect.height ?? 40) + (rect.top ?? 0)`. On macOS full screen
  `getTitlebarAreaRect()` reports `height: 0`; `?? 40` only catches
  null/undefined, so `0 ?? 40` stays `0` → the bar collapses to 0px and
  `emit("height", 0)` lets the content pane cover it. Pre-existing Stage-5 chrome
  logic (not a wave regression).
- **Target behavior (user, VSCode-style):** keep the bar VISIBLE in full screen;
  reserve traffic-light space only when windowed. The `leftInset` half is
  already correct (`fullscreen ? 0 : rect.left`).
- **Fix sketch (~3 lines):** give the bar a stable base height that survives the
  overlay collapse — windowed `height = (rect.height || 40) + rect.top`
  (`||` so a transient 0 → base), full screen `height = 40` fixed, `leftInset`
  unchanged. Full-width bar with everything visible in full screen.

### UI-2 — `canvas.centered` floats too high, covers the interactive center stream
- **Where:** `app/src/components/FrameView.vue` (`StreamView` wraps it).
- **Symptom:** in tracking-single's stacked `.view` column, the debug/frame
  canvas rides up and overlaps the interactive center-wide StreamView.
- **Mechanism:** `.centered` is `position: absolute; top: 50%;
  translate(-50%,-50%)` within `.container`, and the wrapper `.container` is
  `overflow: visible` — when the container height doesn't resolve as expected the
  centered canvas floats up and spills over its neighbor instead of clipping.
  Pre-existing (layout unchanged across all 4 optimization waves).
- **Fix direction:** clip overflow on the container and/or give the stacked
  `.view` children a bounded flex basis/height. Needs live-UI iteration.
- **Note:** partly mooted by the agreed direction to move the debug canvas into
  its own sub-window (see auto-memory `project-multi-subwindow-per-app`), but the
  in-place stacked-layout bug remains for other configurations.

## Perf / architecture findings — folded into the refactor

Design direction captured in planner auto-memory; will consolidate into a
`docs/refactor/` plan when the refactor is scoped.

- **tracking-single caps ~22 fps (expected 60).** Orchestrator JS event-loop
  saturation — the 3 `registry:*` camera loops run ~0.97 util capping capture at
  ~38 fps; KCF itself is only ~0.08 util (async offload works); orchestrator
  `loopLag` ~16 ms. Not a wave regression. → orchestrator as a thin coordinator +
  per-camera CV on dedicated C++ threads (async-kcf first).
- **manage-cameras SHM preview freezes ~every 1–2 s.** Renderer-side per-frame
  `ArrayBuffer` allocation: `shm-client.ts` pool caps at `MAX_POOLED_PER_SIZE=3`
  but 3 same-res previews need ~6 buffers → fresh multi-MB allocation each cycle
  → periodic major GC. Orchestrator/capture side proven healthy (cameras ~55 fps,
  registry util ~0.2, loopLag 0.18 ms). → SHM consumers reuse pre-allocated
  (double-)buffers per stream.

Refactor direction memories: `project-optimization-refactor-seam`,
`project-orchestrator-thin-coordinator`, `project-async-kcf-cpp-thread`,
`project-shm-consumer-reuse-buffer`, `project-multi-subwindow-per-app`.
