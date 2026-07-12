# Manual-control: optional trigger sync + modern center views (2026-07-12)

User ruling: make the disparity-scope capture-mode trigger sync OPTIONALLY
available in manual-control, and bring the disparity-scope center-tile
alternative views (disparity, anaglyph, depth/SGBM) to manual-control's
center tile.

## Current state (assessed)

- **manual-control center views** are the LEGACY display-kernel path:
  `view: "sliced" | "diff" | "depth"` rides `DisplayParams` into the
  server-rendered `session.frame` (diff = kernel difference, depth =
  depth-from-projection with the `depthWindowInv` near/far window).
  disparity-scope superseded both with native pipes: the COMPOSITE brick
  (difference / anaglyph at the configured `anaglyph_style`) and the
  STEREO SGBM (+ pinned-range heatmap) pipes over the warped L/R sources,
  renderer-bound via SHM (`usePipeFrame`), consumer-gated (parked until
  connected).
- **trigger sync** lives in disparity-scope only (spec §trigger-sync):
  intent latch + live engagement state machine — hardware-trigger both
  foveas, round-robin CMD_FRAME on the native mirror stream, budget from
  `pairTriggerBudget` (@lib/camera-config), `trigger_blocked` reasons +
  tray warnings, achieved-rate maturity window. The generic pure core sits
  in `app/modules/disparity-scope/trigger-sync.ts` mixed with
  match-join-specific pair gating.
- **manual-control CAN host it**: it leases the same L/C/R triple and its
  volt writes already ride an MCU stream
  (`controllerNode().openPosition("manual-control")` → `PositionInput`
  with `streamId`) — exactly the stream CMD_FRAME needs. It has NO frame
  pairing (no match-join), so the pair-window/staleness parts of
  trigger-sync stay disparity-only.

## Design

### Lane 1 — shared trigger-sync core (extract, no behavior change)

Move the GENERIC pure parts of disparity-scope's `trigger-sync.ts` to
**`app/lib/trigger-sync.ts`** (pure, Vue/DOM-free, unit-tested):

```ts
export interface TriggerPreconditions { tripleLeased; controller; streamId }
export function triggerBlockReason(p: TriggerPreconditions): string | null
export class TriggerRateWindow { reset(now); onFin(); sample(now) }
export function engageFailureReason(error: unknown, maxLen?): string
export function createTriggerOpChain(onError?): (op) => Promise<void>
export interface TriggerTelemetry {           // moved from disparity contract
  hz: number | null; pulseMs: number;
  frames: number; rejects: number; timeouts: number;
}
```

`app/modules/disparity-scope/trigger-sync.ts` keeps ONLY the
match-join-coupled parts (`pairWindowNs`, `pairEpochGateTrips`,
`matchStaleMsFor`) and re-imports the core. Disparity behavior is
byte-identical; tests split accordingly.

### Lane 2 — manual-control

**Trigger sync (Capture Mode):**
- Contract: `trigger_sync: false` state; `trigger: TriggerTelemetry | null`
  + `trigger_blocked: string | null` telemetry (same shapes/doc voice as
  disparity-scope).
- Session: port the engagement state machine minus pair gating —
  preconditions `{ tripleLeased: triple !== null, controller (v2Capable),
  streamId: posInput?.streamId ?? null }`; budget via `pairTriggerBudget`
  over L/R exposure + settle + max rates; `RoundRobinFrameScheduler` with
  the ONE target (stream = posInput.streamId, cameras L+R, pulse,
  settle_time, minIntervalMs); FIN/REJ/timeout counters +
  `TriggerRateWindow`; FIFO op chain serializing engage/disengage; retry
  tick while intent is on; epoch guard against disengage-during-await;
  disengage + hardware-trigger revert on idle/release. `trigger_blocked`
  published on TRANSITIONS only, detail duplicated to the title-bar tray as
  a warning (8979b44 idiom).
- UI: "Capture Mode" segmented `SingleSelect` (Free-run / Trigger sync) +
  compact always-rendered Status row — mirror the disparity-scope drawer
  block landed in 8979b44 (warn tint while intent≠engaged, tray carries
  detail).
- Non-goals: no pairing, no engaged staleness scaling (no match-join
  here); recording/capture stay frame-stream-based and unaffected.

**Center views:**
- Contract: `view: "sliced" | "disparity" | "anaglyph" | "sgbm"` — legacy
  `"diff"`/`"depth"` RETIRED (any persisted/typed legacy value coerces:
  diff → disparity, depth → sgbm).
- Session: at activate, create the COMPOSITE pipe + STEREO SGBM + HEATMAP
  pipes over the L/R undistorted sources (same helpers, node ids under a
  manual-control scope; `SIGNED_DISPARITY_WINDOW` +
  `SIGNED_DISPARITY_HEATMAP_RANGE` pinned params; consumer-gated — parked
  until the renderer connects). `syncCompositeMode(state.view)` on view
  change; `anaglyph_style` read + live subscribe (retune iff a composite
  view is up). The legacy kernel `diff`/`depth` params retire — remove
  `depthWindowInv` + `depthParams` plumbing and its drawer slider IF
  nothing else consumes them (verify: `sliced` must not depend on
  depthNear/Far).
- Renderer: center tile — `sliced` keeps the magnified `session.frame`
  path; `disparity`/`anaglyph` bind the composite pipe; `sgbm` binds the
  heatmap pipe (`usePipeFrame`, disparity-scope index.vue is the
  reference); select options labeled like disparity-scope (anaglyph label
  follows the configured style).

## Ownership / gates

Lane 1: app/lib/trigger-sync.ts (new), disparity-scope trigger-sync.ts /
contract.ts / session.ts (imports only), trigger-sync tests,
docs/spec/disparity-scope.md pointer. Lane 2: app/modules/manual-control/**,
its tests, docs/spec/manual-control.md, docs/manual page. Gates: vue-tsc,
vitest, vite build, check-boundaries.

## AS SHIPPED (2026-07-12, two-lane wave)

All gates green (vue-tsc, vitest 1353/1353 across 132 files, vite build,
check-boundaries). Both lanes as designed, with these decisions of record:

- **`TriggerTelemetry` is a `type` alias, not an `interface`** (in
  `@lib/trigger-sync`): an interface has no implicit index signature and is
  not assignable to the contract `Serializable` constraint — the interface
  form silently degraded the whole disparity contract's inferred store types
  (~241 tsc errors). Documented inline.
- **`PositionInput.streamId` added** (controller-node.ts): the pinned
  precondition assumed it existed; only `NativePositionInput` had it. Returns
  the lazily-created CMD_STREAM's MCU id (null until the first v2 update),
  which the retry tick already tolerates.
- **Attach sites:** stereo + composite bind the L/R homography-undistort
  pipes (convert fallback when uncalibrated). Node ids:
  `nodeId.stereo("manual")` (SGBM), `nodeId.heatmap(<stereo>, "view")`,
  `nodeId.stereo("manual-composite")` (composite) — the renderer computes the
  same ids (disparity-scope idiom, no state field).
- **`depthWindowInv` removed entirely** (state + depthParams + drawer
  slider + `verge`'s param watcher): nothing but the retired legacy depth
  view consumed it; the display worker now serves only `sliced` (no
  `view`/depth params pushed at all).
- **`coerceView`** maps legacy persisted values (diff → disparity,
  depth → sgbm, unknown → sliced) at every untyped boundary; unit-tested.
- **Teardown ordering:** trigger disengage drains after the pacer stops and
  BEFORE `releaseLeases` (hardware-trigger disable rides
  `lease.reconfigure`); center-view bricks retire before the undistort
  producers (LIFO defer).
- **Capture Mode UI** sits after the Capture/Raster buttons in the drawer:
  segmented Free-run/Trigger-sync select with warn tint while
  intent ≠ engaged, compact Status row, blocked detail in the title-bar tray
  (the 8979b44 idiom).
- Environment fixes riding this wave: `telecanvas` (added by the sibling
  session's f342bf9) installed; `@fortawesome/fontawesome-svg-core` was an
  undeclared peer dep that the install pruned — now declared in
  app/package.json.

RIG-GATED: all trigger-sync hardware behavior (HW trigger enable/disable,
CMD_FRAME scheduling on the JS position stream, achieved-rate readout) and
the three native center views' visual correctness in manual-control —
stage-f "Manual Control" gains both checklists.
