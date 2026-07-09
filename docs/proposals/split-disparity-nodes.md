# Split disparity nodes (slice + per-side template match + pid join)

Status: **SHIPPED (code-complete 2026-07-09, through `7128f5a`; rig pass
owed — `hardware/stage-f.md` §"Split disparity nodes")**. Supersedes the
monolithic disparity kernel (`win/disparity-scope/disparity`, C-22b) — the
last app-private many-input vision worker.

## The rulings (user, 2026-07-09, verbatim intent)

1. **Left and right disparity are computed separately** by spawning two
   separate disparity nodes.
2. **Slicing of the center tile is done by a dedicated node.**
3. The **disparity (templateMatch) node and the slicing node are both
   general-purpose reusable components** — nothing disparity-scope-specific
   inside them.
4. The **outputs of both sides feed the application-specific
   `win/disparity-scope/pid` node**, which translates the offsets into
   control feedback and **outputs position streams** (to the controller
   node).
5. **A scale/resize node** (added ruling, same session): a general-purpose
   node accepting a REACTIVE param of either `ratio`, `dheight`, `dwidth`,
   or `dsize` (both h and w). One sits **in front of each templateMatch
   input** — the match guide (strip) and the match kernel (fovea needle)
   both arrive pre-sized, so the match node does no resizing at all.

## Topology (after)

```
camera/<C>/undistort ─► …/slice/scope-strip ─► …/scale/match ────────► match/L (haystack)   match/L ─► win/disparity-scope/pid ─► controller
                    └─► …/slice/scope-tile                     └─────► match/R (haystack)   match/R ─►        ▲
camera/<L>/convert ──► …/convert/scale/scope-needle ─(needle)──────► match/L                                 │ (target)
camera/<R>/convert ──► …/convert/scale/scope-needle ─(needle)──────► match/R                camera/<C>/undistort/kcf
```

- `slice/scope-strip`: the match haystack CROP — the target-centered center
  tile expanded by `expand_x/expand_y`. One crop, shared by both sides.
- `…/scope-strip/scale/match`: the strip SCALER (`ratio = downsample`) — the
  pre-sized haystack both match nodes read.
- `camera/<L|R>/convert/scale/scope-needle`: per-side needle scaler
  (`dsize = foveaTileSize(...)`) — the pre-sized match tile. Source is the RAW
  fovea CONVERT pipe, NOT the homography-undistort pipe (round-2 too-small-
  needle fix, 2026-07-09): the warp already lands the fovea at wide density, so
  `foveaTileSize` would divide by the magnification a second time (≈81× area
  too small). The raw convert pipe fills the frame at fovea-native resolution
  → a single, correct ÷magnification. The undistort pipes stay the
  stereo/composite source.
- `slice/scope-tile`: display-only — the unexpanded center tile the "Wide
  Angle Sliced" view shows. Pure view pipe; no consumer other than the
  renderer.
- `match/L`, `match/R`: per-side template match — pure correlation, no
  resizing (ruling 5).
- `pid`: the ONLY app-specific node. Joins the two match streams, runs the
  vergence control law, pushes the controller-node position stream.

## Design (pinned)

### Slice node = the existing native fovea-crop brick, reused

`Aravis.attachFoveaPipe(sourcePipeId, pipeId, {rect})` +
`setFoveaRect(pipeId, rect)` already IS the general-purpose slice node:
chained on the shared undistort brick (demand propagation keeps the chain
awake), C-20 variable-size pipe (max footprint ring; every frame carries its
ACTIVE w/h and **frame-bound crop origin** in the v4 slot header),
self-metered + self-reported topology. No new native code.

New session-side reusable wrapper: **`app/orchestrator/slice-pipe.ts`** —
advertise the max-footprint pipe + attach + live-steer + retire, seam-
injected (unit-tests without native core), mirroring
`createFoveaMaterializer`'s body but SESSION-owned (no renderer compose
churn). Ids: **`nodeId.slice(serial, name)`** →
`camera/<serial>/undistort/slice/<name>` (nests under /undistort/ because
that IS its input — same rule as fovea/kcf). The native brick reports kind
"fovea" (it is the same brick); the id spells the role.

### Scale node = a NEW native chained brick (`ScaleStream`)

Workers are read-only SHM (they cannot publish pipes), so a node whose
output other nodes consume must be a native brick. `ScaleStream` mirrors
the fovea brick's shape exactly:

- `Aravis.attachScalePipe(sourcePipeId, pipeId, params)` — chained on any
  convert/undistort/fovea pipe's OwnedFrame tap (Leaky/latest-wins input,
  demand propagation keeps the upstream chain awake).
- **Reactive params** (`Aravis.setScaleParams(pipeId, params)`, applied on
  the next frame, no re-attach): exactly one of
  `{ratio} | {dwidth} | {dheight} | {dsize: {width, height}}` —
  `dwidth`/`dheight` preserve aspect; output dims recomputed PER FRAME from
  the params + that frame's active input dims (variable-size sources like a
  slice pipe just work).
- `Aravis.detachScalePipe(pipeId)`; `Aravis.scaleProbeAll()` (meter rows,
  keys = node ids); Topology self-report (`scale ← source` edge).
- C-20 variable-size pipe: JS advertises the max-footprint ring; every
  frame carries its ACTIVE out dims; the source frame's crop ORIGIN is
  forwarded UNSCALED (source full-res coords) — consumers un-scale rect
  coords with the ratio they commanded, then add the origin.
- cv::resize, INTER_AREA when shrinking / INTER_LINEAR when growing.
- Session-side reusable wrapper **`app/orchestrator/scale-pipe.ts`**
  (advertise + attach + reactive retune + retire), seam-injected like
  slice-pipe.ts. Ids: **`nodeId.scale(sourceId, name)`** →
  `<sourceId>/scale/<name>`.

### Disparity node = a generic `template-match` vision-worker kernel

**`app/orchestrator/template-match-kernel.ts`**, registered as
`kind: "template-match"`. Roles (protocol `Role` widens to `string`):

- `needle` — the PRE-SIZED tile (here: the fovea's scale pipe). Grayscale
  once per new needle frame; retained across ticks.
- `haystack` — the PRE-SIZED strip (here: the strip's scale pipe).
  Grayscale; each haystack arrival drives one match tick.

Params: `{ gaussKsize?, gaussSigma?, heatmap? }` — NO geometry (ruling 5:
sizing lives in the scale nodes; the caller owns the zoom/magnification
math via `foveaTileSize`/`matchMagnification` and retunes the scalers).
Output values per tick:

```ts
{ rect,          // matched needle footprint, HAYSTACK-local px (scaled space)
  score,         // CCOEFF_NORMED peak
  origin,        // {x,y} = the haystack frame's forwarded crop origin
  seq, deviceTimestamp }   // of the driving haystack frame
```

plus an optional `match` heatmap frame. **`origin` is the load-bearing
trick**: the slice pipe stamps every frame with where the crop sits in the
wide frame, the scaler forwards it, so `origin + rectCenter/downsample` is
an ABSOLUTE undistorted-wide-frame position — the kernel never needs the
target, and the old target/`overridden` params plumbing through the kernel
dies entirely.

### The pid node joins

Per-side results land on the session keyed L/R; the vergence step runs when
the arriving side COMPLETES a pair (`arriving.seq >= other.latest.seq` —
order-agnostic, ~once per strip frame, degrades to the slower side's rate).
The step composes the `ScopeProjection` exactly as before (`l`/`r` from
origin+center, `target` = session state, `scores`, `overridden` now
SESSION-LOCAL — the drag flag never rides a worker). `stepVergence`,
`followTarget`, the drag rulings (direct parallel follow, reset at drag
start), the freeze window, and the controller-node position input are all
unchanged — the pid node was already the control half; it just gains the
join.

### Views

- "Wide Angle Sliced" ← `slice/scope-tile` pipe directly (`usePipeFrame`).
- "Template Match Guide Strip" ← `slice/scope-strip` pipe directly (the old
  kernel-emitted `guide` was a downsample→re-upscale roundtrip of exactly
  this crop; the overlay rects are strip-local full-res, which is what the
  per-side telemetry now carries).
- "Disparity (L vs R)" ← renderer-composed **DiffView** (canvas
  `globalCompositeOperation: "difference"` of the two fovea undistort pipes
  the window already binds). The kernels can no longer diff (neither sees
  both foveas) — and never should have: it is a pure display composite.
- `match_left` / `match_right` heatmaps stay session frame channels (one per
  match worker).

### Deletions

- `app/modules/disparity-scope/vision.ts` (the monolithic kernel) + its
  `disparity` registry entry.
- `analyzeVergence` / `getFoveaTile` / `getMatchTile` / `processMatch` from
  vergence.ts (the mechanism moves into the generic kernel; the pure
  geometry — `foveaTileSize`, `matchMagnification`, `stepVergence`,
  `followTarget`, `seedVergence`, `scopeProjection` — stays and keeps its
  tests).

## Rig items

Added to stage-f §"Split disparity nodes" (graph shows slice/match nodes with
meters; per-side match rects/scores; join rate ≈ strip rate; sliced/guide
views at pipe rate; DiffView parity; drag semantics unchanged).

## AS SHIPPED (2026-07-09, commits 544791e + f1be670)

Implemented exactly as ruled. Deltas/notes against the sections above:

- ScaleStream resolves sources via findUndistort → findConverter →
  findFovea (added — scale chains on slice pipes) → findScale (scale-on-
  scale composes); `kind: "scale"` Topology self-report rows.
- The strip scaler's advertised max footprint is 2× the wide frame
  (extreme zoom/expansion combos clamp natively rather than over-allocate
  the ring); slices max at the full frame.
- The join steps on seq PAIR COMPLETION (`arriving.seq >= other.latest`) —
  order-agnostic, ~once per strip frame, slower-side degradation.
- `overridden` went session-local (`dragging`) — the one-kernel-tick flag
  lag the old plumbing had is gone with the plumbing.
- vergence.ts is now CORE-FREE pure math (the native-mock shim left its
  test); `match_center` telemetry anchors to each result's actual strip
  origin so the guide marker stays aligned mid-steer.
- Gates at close: core make + tests 25/09/18/22/23/12; vue-tsc 0; vitest
  456/456; vite build 0 (orchestrator 242.61 kB, vision-worker 10.03 kB).
  Rig pass owed: stage-f §"Split disparity nodes".
