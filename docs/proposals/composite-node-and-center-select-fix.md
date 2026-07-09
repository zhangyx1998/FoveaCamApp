# Composite (anaglyph/difference) node + center-select dropdown fix

Status: **SHIPPED (code-complete 2026-07-09, `59ad332`; rig pass owed —
`hardware/stage-f.md` §"Composite node + center select")**. AMENDS
`stereo-disparity-and-heatmap-nodes.md` §Anaglyph: the anaglyph (and the
L-vs-R difference) center views become a REAL two-input native brick with a
node-graph row — the "renderer canvas composite" design is retired.

## The report (user, 2026-07-09)

> There is no anaglyph node in the nodegraph, nor is there a dropdown on the
> center tile of the disparity scope to switch between sliced center view /
> anaglyph view and SGBM heatmap view.

## Root causes (diagnosed, planner)

1. **Dropdown never rendered.** `index.vue` passes the view `InlineSelect`
   through `<template #title>` on **StreamView** — but StreamView does NOT
   forward any named slot to FrameView (it only passes the default slot), so
   the select was silently dropped on the `sliced` and `sgbm` branches. The
   legacy master UI worked because it used **FrameView directly**, which has
   the `title` slot (and a `title` default of `""`, so the bar renders).
   StreamView additionally defaults `title` to `null`, and FrameView hides
   the entire title bar when `title === null`. Since `sliced` is the default
   view, the user never saw ANY dropdown and could not switch views.
2. **No anaglyph node.** Anaglyph shipped as a renderer canvas composite
   (DiffView mode) — deliberately node-less. The profiler graph has no
   renderer-node mechanism (pipes get anonymous `<pipeId>/consumers` sinks
   only), so a visible anaglyph node requires the compute to live in a real
   brick. The user's report makes that the ruling — and it also moves
   per-frame canvas compositing OFF the renderer (the Graphite GPU crash came
   from sustained many-canvas `putImageData` load; one composed BGRA pipe is
   strictly cheaper than three mask/composite canvas passes per frame).

## Design (pinned)

### A. Dropdown fix (renderer chrome)

- **StreamView**: forward all named slots to FrameView with the standard
  dynamic pattern
  (`<template v-for="(_, name) in $slots" #[name]="p"><slot :name="name" v-bind="p ?? {}" /></template>`)
  — only slots the caller actually passed are forwarded, so untitled
  StreamViews are unchanged.
- **FrameView**: render the title bar `v-if="title !== null || !!$slots.title"`
  — a slot-only title (master's exact center-view pattern) shows the bar.
  FrameView-direct users are unchanged (`""` default already truthy-renders).

### B. `CompositeStream` — two-input composite brick (core)

Clone the StereoStream skeleton (two TapChannels/TapPublishers opened in
`start()`, closed BEFORE unsubscribe in `stop()`; left-paced `iterate()`,
latest-wins right drain; dims mismatch → metered drop; LEFT frame's
timestamps + origin forwarded — trusted-time):

- **Compute** (BGRA8 in ×2 → BGRA8 out, alpha 255), reactive param
  `{ mode: "anaglyph" | "difference" }`:
  - `anaglyph`: out.R = LEFT.R; out.G = RIGHT.G; out.B = RIGHT.B (red = LEFT
    eye, cyan = RIGHT — same parity as the shipped DiffView mode).
  - `difference`: `cv::absdiff(L, R)` on the color channels.
- **NAPI seam** (ScaleStream/StereoStream pattern): `attachCompositePipe(
  leftPipeId, rightPipeId, pipeId, params)` / `setCompositeParams` /
  `detachCompositePipe` / `compositeProbeAll` + `appendCompositeReports`
  (kind `"composite"`, `left`/`right` BGRA8 input edges, BGRA8 output) wired
  into `Topology.report()` + addon exports + `core/dist/Aravis/index.d.ts`
  typings. Source resolution = StereoStream's `resolveSource`
  (undistort → convert → fovea → scale). Mode validated NAPI-side; matcher-
  style guarded pending + atomic flag for the retune (rebuilt state is just
  the mode enum — trivial).
- **Consumer-gated** (C-21): parked until the pipe has a consumer, exactly
  like stereo/heatmap — selecting the view IS the demand.

### C. Session + ids (app)

- `app/orchestrator/composite-pipe.ts` wrapper (advertise BGRA8 at the L
  camera's max dims + attach + retune + retire), seam over
  `pipeBroker.advertise` in `index.ts` (+ `registerNativeProbe`), injected
  into the disparity-scope session like stereo/heatmap.
- Session `activate` composes `createCompositePipe(seam, undistortL,
  undistortR, nodeId.stereo("composite"), camDims)` right beside
  `stereo/scope` (inputs = the two per-camera UNDISTORT pipes — what DiffView
  consumed); teardown disposer with the others (retire before the undistort
  retirers). NO new contract surface: the session already syncs
  `state.view` — watch it server-side and retune `mode` when it lands on
  `disparity` ("difference") or `anaglyph` ("anaglyph"); other views leave
  the mode alone (the node is parked anyway).
- Node id: `stereo/composite` (reuses `nodeId.stereo` — a cross-camera join;
  NO graph-contract change, that file is planner-owned and already has the
  helper). Profiler: register the `"composite"` node kind wherever the view
  styles `"stereo"`/`"heatmap"` kinds (grep `app/src/profiler` for those).

### D. Center tile becomes ONE StreamView (renderer)

All four center views are now pipe-backed — collapse the three template
branches into a single StreamView bound to a computed pipe id:

```ts
sliced    → nodeId.slice(serials.C, "scope-tile")
disparity → nodeId.stereo("composite")   // session retunes mode
anaglyph  → nodeId.stereo("composite")
sgbm      → nodeId.heatmap(nodeId.stereo("scope"), "view")
```

`usePipeFrame` over that computed id keeps the on-demand rule for every
option (connect-while-selected; disparity↔anaglyph flips retune the SAME
connected pipe — no reconnect churn). The `InlineSelect` rides the (now
working) `#title` slot once. **Delete `DiffView.vue`** — disparity-scope was
its sole user (grep-verified); update the contract/session comments that
mention it (`contract.ts` view doc, `session.ts` header).

### E. Tests + gates

- **Core test 27** (`core/test/27-composite-pipe.ts`, test-26 pattern): fake
  camera + two offset slice crops; attach `stereo/composite`; parked before
  a consumer connects; connect → BGRA8 frames with alpha 255 and BOTH input
  ports metered; **anaglyph channel identity** (output R plane == LEFT crop's
  R plane, G/B planes == RIGHT crop's) and **difference sanity** (zero
  offset ⇒ color planes all zero); reactive mode retune (invalid mode
  throws, unknown pipe → false); park on disconnect; idempotent detach +
  orderly teardown + natural exit.
- Gates: `cd core && make` clean + hardware-free tests
  09/12/18/22/23/25/26/27; from `app/`: `../node_modules/.bin/vue-tsc
  --noEmit` + `../node_modules/.bin/vitest run`. NEVER launch Electron.
  `vite build` is the planner's wave-close gate.

## Rig items (stage-f)

Center dropdown visible on ALL four views (including the default sliced) and
switches live; anaglyph node `stereo/composite` appears in the profiler graph
with meters ONLY while disparity/anaglyph is selected (parked otherwise);
anaglyph red = LEFT / cyan = RIGHT parity (cover the left fovea → red goes
dark); disparity↔anaglyph flip retunes without a frame gap; renderer CPU/GPU
load DROPS vs the old canvas composite (Graphite-relevant).

## AS SHIPPED (2026-07-09, commit 59ad332)

Implemented as ruled (worker-built, planner-verified). Deltas/notes:

- Anaglyph compute pinned as `right.copyTo(buf)` + `mixChannels` of LEFT's R
  plane (BGRA channel 2) — one copy + one plane splice, alpha forced 255 via
  a reused mask; difference = 4-channel `absdiff` with the alpha restored.
- Profiler kinds: `stereo`/`heatmap`/`scale` were never in `KIND_COLORS`
  (default slate); only a `composite` entry was added. Backfilling the other
  kinds' colors is OPEN (cosmetic).
- Composite inputs = `needleSources.L/R` (undistort when calibrated, convert
  fallback) — exactly what DiffView's `frameL/frameR` bound.
- Gates at close: core make clean + tests 09/12/18/22/23/25/26/27 (27:
  anaglyph channel identity 100%, zero-offset difference == 0, alpha 255,
  park/wake/park); vue-tsc 0; vitest 458/458; vite build 0 (orchestrator
  247.28 kB gzip 74.53 kB). Rig pass owed: stage-f §"Composite node +
  center select".
