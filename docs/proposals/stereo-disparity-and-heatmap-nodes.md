# Stereo SGBM + heatmap nodes; center-view anaglyph/SGBM restore

Status: **RULED** (user, 2026-07-09). Follow-up to
`split-disparity-nodes.md` — the center view's option set grows back past
the split.

## The rulings (user, 2026-07-09, verbatim intent)

1. **Restore the previously available anaglyph and SGBM disparity options
   for the center view** (the disparity-scope center select, which the
   split wave had reduced to sliced | L-vs-R difference).
2. **These streams compute only on demand** — no subscriber → no compute.
3. **SGBM is a universal node producing floating-point disparity maps,
   chained into a universal heatmap node for RGBA visualization.**

Also fixed in the same wave (not ruled, defects): the C-20 renderer read
under-provisioning that blanked every variable-size pipe view ("No Frame",
commit 9e15592) and the pid→controller profiler edge reading a false 0 Hz
(b1ba49d).

## Topology (added)

```
camera/<L>/undistort ─(left)──► stereo/<name> ──► stereo/<name>/heatmap/<view> ──► renderer
camera/<R>/undistort ─(right)─►   (F32 disparity)      (BGRA8 colormap)
```

Disparity-scope instance: `stereo/scope` + `stereo/scope/heatmap/view`.

- **`stereo/<name>`** (NEW brick `StereoStream`): the FIRST two-input
  chained brick. Both inputs are OwnedFrame taps (Leaky/latest-wins) on any
  frame brick (undistort / convert / fovea / scale — same source resolution
  as ScaleStream). Output: single-channel **CV_32F disparity** pipe
  (`pixelFormat: "Disparity32F"`, `dtype: "F32"`, channels 1 — a new
  `PipeDtype = Dtype | "F32"` at the PIPE contract, leaving the sensor
  schema untouched; the spec's pixelFormat is already a plain string and no
  current consumer decodes this pipe).
- **`<sourceId>/heatmap/<name>`** (NEW brick `HeatmapStream`): a
  single-input chained brick (ScaleStream's exact shape) that colormaps a
  1-channel input (F32 or U8) to BGRA8. Reactive params:
  `{ min?, max? }` — both absent = per-frame min/max auto-normalize;
  colormap TURBO. It is what the renderer actually binds.

### On-demand (ruling 2) — no new mechanism

The existing consumer gate + demand propagation IS the ruling: the session
composes both bricks at activate, but a chained brick runs iff its pipe has
consumers or a downstream tap subscribes. Nothing connects the heatmap pipe
until the renderer selects the SGBM view → both bricks stay parked and the
SGBM cost is exactly zero. Selecting the view connects the heatmap pipe →
gate wakes HeatmapStream → its tap wakes StereoStream → its two taps keep
the L/R undistort bricks awake (they already are — the side views read
them). Deselecting reverses it. The same rule now gates the renderer's
other center-view pipes: the sliced view's `usePipeFrame` id is null unless
that view is selected (the scope-tile slice parks when unwatched).

### StereoStream (pinned)

- `Aravis.attachStereoPipe(leftPipeId, rightPipeId, pipeId, params)` /
  `setStereoParams(pipeId, params)` (reactive, fovea `setRect` pattern) /
  `detachStereoPipe(pipeId)` / `stereoProbeAll()` (meter rows, keys = node
  ids) / Topology self-report: `left`/`right` input edges + `kind:
  "stereo"`.
- TWO TapPublishers opened in `start()`, closed in `stop()` — demand
  propagates to both sources; either source terminating ends the brick
  (ChainedStream contract).
- Pairing: tick on every LEFT arrival, matched with the LATEST RIGHT frame
  (latest-wins; no seq comparison across cameras — different owner clocks
  pace them). No right frame yet → skip. Output timestamps = the LEFT
  frame's (trusted-time: forwarded, never re-stamped). Left is the pacing
  side by convention (caller passes left first).
- Compute: BGRA→GRAY both sides, `cv::StereoSGBM` (`mode_SGBM`),
  `compute` → CV_16S fixed-point → `convertTo(CV_32F, 1/16)` full-res
  float disparity. Input dims must match (unequal → drop + `meter_.drop`,
  the transient during steering/retune).
- Reactive params (validated NAPI-side): `{ numDisparities?, blockSize?,
  minDisparity? }` — numDisparities rounded up to ×16 (default 128),
  blockSize forced odd (default 5), minDisparity default 0. The SGBM
  matcher is rebuilt on the brick thread when params change.
- C-20 pipe: max footprint = the advertised max dims; per-frame active
  dims; origin forwarded from the LEFT frame unscaled (disparity is in
  left-frame coordinates).

### HeatmapStream (pinned)

- `Aravis.attachHeatmapPipe(sourcePipeId, pipeId, params)` /
  `setHeatmapParams` / `detachHeatmapPipe` / `heatmapProbeAll()` /
  Topology `kind: "heatmap"` row. Source resolution: findStereo →
  findUndistort → findConverter → findFovea → findScale.
- Accepts CV_32FC1 or CV_8UC1 input frames (else drop-with-reason);
  normalizes to [0,1] by reactive `{min,max}` (absent → per-frame
  min/max), maps through `cv::COLORMAP_TURBO`, emits BGRA8 (alpha 255).
  Active dims + origin + timestamps forwarded.

### Session wrappers + ids

`app/orchestrator/stereo-pipe.ts` + `heatmap-pipe.ts`, seam-injected like
scale-pipe.ts (advertise + attach + retune + retire). `nodeId.stereo(name)`
→ `stereo/<name>` (a new root: a cross-camera join honestly belongs to
neither camera; its edges carry the wiring). `nodeId.heatmap(sourceId,
name)` → `<sourceId>/heatmap/<name>` (nests under its input, scale rule).

### Anaglyph (ruling 1, renderer-side) — SUPERSEDED

> **AMENDED 2026-07-09** (`composite-node-and-center-select-fix.md`): the
> anaglyph AND difference views are now a real two-input native brick
> (`stereo/composite`, CompositeStream) with a node-graph row; DiffView is
> deleted. The section below records the original (retired) design.

A pure display composite of the two fovea undistort pipes the window
already binds — same class as the difference view, so **DiffView gains a
`mode` prop**: `"difference"` (as shipped) | `"anaglyph"` (red = LEFT eye,
cyan = RIGHT: L×#f00 'multiply' + R×#0ff 'multiply', composed 'lighter').
No orchestrator involvement; computes only while mounted (ruling 2 holds
trivially). Also fixes the non-reactive "No Frame" overlay (the template
read plain `offA.width`, which never re-renders — a painted-state ref now
drives it).

### Center select (disparity-scope)

`state.view: "sliced" | "disparity" | "anaglyph" | "sgbm"` (contract).
Views: sliced = scope-tile slice pipe (connected only while selected);
disparity/anaglyph = DiffView modes over frameL/frameR; sgbm = StreamView
over the heatmap pipe (connected only while selected — the on-demand gate).

## Rig items

Stage-f §"Stereo SGBM + heatmap nodes": SGBM view shows a plausible
disparity heatmap on a static scene; graph gains stereo/scope +
heatmap/view nodes with meters ONLY while the view is selected (parked
otherwise — verify the rate drops to 0 and CPU returns); anaglyph view
red/cyan parity; sliced view park/resume on view toggle.

## AS SHIPPED (2026-07-09, commits 9e15592 → 2fd1f19)

Implemented as ruled. Commits: 9e15592 (renderer C-20 read fix — the "No
Frame" root cause preceding the restore), b1ba49d (pid meter / false-0Hz
fix), debef58 (core StereoStream + HeatmapStream, worker-built +
planner-finished), 2fd1f19 (app half). Deltas/notes:

- The publisher path needed one link-critical additive change:
  `FrameInfo.bytesPerElement` (`elemSize1()`, default 1 — every U8 pipe
  byte-identical) so a CV_32FC1 mat publishes untruncated through the
  tight-packed row math.
- `ContainerDtype = Dtype | "F32"` landed in graph-contract (StreamType +
  pipe spec + the profiler's FRAME helper reuse it); the sensor schema is
  untouched.
- StereoStream is NOT a ChainedStreamOf specialization — a small two-source
  sibling (two TapChannels/TapPublishers, left-paced iterate, both channels
  closed before unsubscribe in stop(), preserving the FIFO-deadlock note).
- Right-input metering: one `right` ingest per NEW frame consumed; the
  drained-and-superseded seq gap meters as drops (expected latest-wins).
- Test 26 synthesizes the pair as two slice crops of the same fake-camera
  source offset by 24 px: median disparity read back 24.0 px; the on-demand
  gate proven end to end (zero frames before the heatmap consumer connects,
  parked again after disconnect).
- DiffView's "No Frame" overlay was non-reactive (plain `offA.width` in the
  template) — fixed with a painted ref while adding the anaglyph mode.
- Gates at close: core make clean + tests 09/12/18/22/23/25/26; vue-tsc 0;
  vitest 458/458; vite build 0 (orchestrator 245.68 kB gzip 74.17 kB).
  Rig pass owed: stage-f §"Center-view restore + stereo SGBM/heatmap
  nodes".
