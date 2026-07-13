# Viewer tiles: full-width split, theme color, projectable (2026-07-13)

Follow-up to viewer-timeline-touchup.md. Four user rulings on the preview
tiles panel + one timeline tweak.

## Rulings (user, 2026-07-13)

1. **Instantaneous bounce** — the timeline overscroll spring-back
   (`animateSettle`, currently a 200 ms eased rAF) snaps back immediately on
   gesture-idle/release. The rubber-band RESISTANCE during the drag
   (`panSoft`) stays; only the settle is instant.
2. **Theme color wherever related** — extend the per-track theme color
   (timeline `trackColor`, L/C/R role hues) to every related surface: tile
   header chip + accent, tile focus/highlight outline, and the projection
   pane accent (`Pane.theme`) when a tile is projected.
3. **Full-width, non-scroll, divider-resize tiles** — the tiles panel is one
   horizontal row that ALWAYS fills 100% of the panel width, never scrolls.
   Tile widths are PERCENTAGES; dragging a divider between two adjacent tiles
   resizes that pair (sum preserved). The px `tileWidth` slider + horizontal
   scroll are retired. Sizes persist in the sidecar.
4. **Projectable tiles** — each stream tile gets the project-to-window
   affordance (the `FrameView` `projection` button + drag), opening/feeding a
   projection window that MIRRORS the tile (its resolved playhead/3D frame).

## Assessment: projecting a viewer tile

The projection system binds a pane to a LIVE source — `{kind:"frame"}` (a
`useSession` frame ref) or `{kind:"pipe"}` (a SHM pipe). The viewer has
neither: it decodes a `.fovea` in a per-window utilityProcess engine and the
renderer holds the Mats (`mats` map / composed pair Mats). A projection
window is a separate BrowserWindow with no access to those Mats.

**Chosen architecture — mirror-follow via a same-origin frame broadcast
(ref-counted).** The viewer renderer re-broadcasts the Mat a tile currently
DISPLAYS (after pair-collapse / 3D resolution) to any projection subscribed
to that (recording, channel-or-tile-key). This mirrors the tile exactly —
playhead, 3D mode, everything is resolved viewer-side — which is precisely
what "project this tile" means, and it reuses the freeze-on-close state
machine (posts stop → pane goes idle → "source has closed"). Rejected the
alternative (projection re-opens the file + its own engine + cross-window
playhead sync): far more code, duplicate decode, and a sync problem this
avoids entirely.

Cost control: the broadcast is REF-COUNTED — the viewer only serializes +
posts frames for tile keys a projection has actively subscribed to, so with
no projection open the hot path is untouched. Frames ride a
`BroadcastChannel` (same app origin across BrowserWindows); the Mat's backing
buffer is structured-cloned per post (a copy — acceptable at the coalesced
viewer frame rate for the handful of projected tiles; capped to the viewer's
existing `frameTick` cadence, no new timer).

## Design

### Lane PURE (no ViewerWindow.vue edits)

**`app/lib/projection/descriptor.ts`** — new `ViewerPaneSource`:
```ts
export type ViewerPaneSource = { kind: "viewer"; recording: string; tileKey: string };
export type PaneSource = FramePaneSource | PipePaneSource | ViewerPaneSource;
```
`parsePaneSource` validates it (defensive, version-safe); `PANE_CODEC_VERSION`
bumps to 2 (parse still accepts v1 frame/pipe — additive). `tileKey` is the
viewer's stable per-tile key (single channel name, or `pair:<base>` for a 3D
tile) so the broadcast key matches the tile identity across scrub/reorder.

**`app/src/viewer/viewer-frame-bridge.ts`** (NEW, pure-ish — BroadcastChannel
only, no Vue/DOM-Mat coupling in the transport shape):
```ts
export const VIEWER_FRAME_CHANNEL = "fovea:viewer-frames";
export interface ViewerFrameMsg {   // viewer → projection
  type: "frame"; recording: string; tileKey: string;
  width: number; height: number; channels: number; buffer: ArrayBuffer;
}
export interface ViewerSubMsg {     // projection → viewer
  type: "subscribe" | "unsubscribe"; recording: string; tileKey: string;
}
/** Viewer side: owns the channel, tracks the live subscriber ref-counts
 *  ((recording,tileKey) → count), exposes `wanted(recording,tileKey)` and
 *  `post(msg)`; notifies on subscription change so the viewer can start/stop
 *  serializing. */
export function createViewerFramePublisher(recording: string,
  onWantedChange: () => void): {
    wanted(tileKey: string): boolean;
    post(tileKey: string, mat: { data: Uint8Array; shape: readonly number[] }): void;
    dispose(): void;
  };
/** Projection side: subscribe to one (recording,tileKey); calls `onFrame`
 *  with the latest message; `close()` unsubscribes. Emits the subscribe
 *  message on open + re-emits periodically (heartbeat) so a viewer that
 *  opened later still learns of the demand. */
export function subscribeViewerFrame(recording: string, tileKey: string,
  onFrame: (m: ViewerFrameMsg) => void): { close(): void };
```
Unit-tested with a BroadcastChannel stub (jsdom provides one; else a minimal
fake) — ref-count add/drop, wanted() transitions, message round-trip shape.

**`app/src/viewer/tile-split.ts`** (NEW, pure):
```ts
export const MIN_TILE_FRACTION: number;   // e.g. 0.06 — a floor per tile
/** N tiles → equal fractions summing to 1 (the default + on count change). */
export function equalFractions(n: number): number[];
/** Reconcile a persisted fraction list to `n` tiles (drop/append + renorm to
 *  sum 1); identity when already valid. */
export function reconcileFractions(fr: readonly number[] | undefined, n: number): number[];
/** Drag divider `i` (between tile i and i+1) by `deltaFrac`: move the shared
 *  edge, clamped so neither tile drops below MIN_TILE_FRACTION; the rest
 *  unchanged; sum stays 1. Returns a NEW array. */
export function resizeAtDivider(fr: readonly number[], i: number, deltaFrac: number): number[];
```
Unit-tested: equal/reconcile/renorm, divider clamp at both floors, sum
invariance, degenerate n≤1.

**`app/src/viewer/sidecar.ts`** — add `tileSizes?: number[]` (fraction list,
defensive parser like `tileOrder`); RETIRE `tileWidth` from the written shape
but keep tolerating it on read (old sidecars parse without error — ignore the
field). Keep MIN/DEFAULT constants only if still referenced; otherwise remove.

**`app/src/windows/ProjectionPane.vue`** — render a `{kind:"viewer"}` source:
`subscribeViewerFrame`, rebuild a `Mat<Uint8Array>` from each message
(`makeMat`/`createMat` in `@lib/mat`), feed `FrameView`. Wire it into the
same status/idle/closed machine (a stale/absent stream = source lost → the
existing cover). No changes to frame/pipe paths.

### Lane VIEWER-UI (ViewerWindow.vue only)

- **Ruling 1:** replace `animateSettle`'s rAF ease with an immediate
  `viewport.value = settleTarget(...)` (drop the DUR/step loop + `settleRaf`
  bookkeeping for the settle; keep the smooth-playhead rAF untouched).
- **Ruling 3:** the `.tiles` row becomes `display:flex; width:100%;
  overflow:hidden`. Each slot's width = `fraction*100%` from a `tileSizes`
  ref (`reconcileFractions(sidecar, orderedSlots.length)`, defaulting to
  `equalFractions`). Insert a divider handle between adjacent tiles;
  pointer-drag calls `resizeAtDivider` (deltaFrac = dragPx / panelWidth),
  persisted on release. Delete the `tileWidth` slider, `onTileWidth*`, the
  `MIN/MAX/DEFAULT_TILE_WIDTH` usage, and the fixed `width: tileWidth+px`
  bindings. Header-drag REORDER stays (the mid-x hit test still works on
  flex children); the reorder drop-indicator coexists with dividers.
- **Ruling 2:** thread `trackColor` (already `slotColor(slot)`) into: the
  tile head chip fill + a subtle tile border/outline accent (rest state
  faint per the ruling-7 borderless idiom; focus/highlight raise it), and
  pass it as the projected pane's `theme`.
- **Ruling 4:** give each real tile a `FrameView :projection` descriptor:
  `{ source: { kind:"viewer", recording: basename, tileKey: tileKeyOf(tile) },
  title: tileLabel(tile), theme: slotColor(slot) }`. Stand up a
  `createViewerFramePublisher(basename, …)` for the window; on each
  `frameTick`, for every displayed tile whose key is `wanted()`, `post()` its
  current `tileMat`. Placeholders are not projectable (no frame).
  `tileKeyOf` MUST match the projection descriptor's `tileKey` and the
  broadcast key (single channel, or `pair:<base>`).

### Docs

`docs/spec/viewer.md` (tiles → split layout, projectable tiles + the
broadcast source), `docs/spec/projection.md` (the `viewer` source kind),
`docs/manual/viewer.md` (divider resize, project a tile), stage-f Viewer
checklist (divider feel, projection mirror correctness + freeze-on-close),
proposals/README.md row.

## Non-goals

Projection does NOT get its own transport/scrubbing — it mirrors the viewer
tile. Multiple projections of the same tile share one subscription (ref
count > 1). No persistence of the viewport (unchanged from last wave).

## AS SHIPPED (2026-07-13, two-lane wave)

All four rulings landed; gates green (vue-tsc, vitest 1444/1444 across 136
files, vite build, boundaries). Decisions of record:

- **Pure lane** — `ViewerPaneSource` added (`PANE_CODEC_VERSION` → 2 via a new
  `acceptsCodecVersion` gate so v1 panes still parse); `viewer-frame-bridge.ts`
  (ref-counted BroadcastChannel; `ViewerSubMsg` gained an internal `id?` so the
  heartbeat can't double-count a re-announced subscriber); `tile-split.ts`
  (sum-to-1 fraction math, `MIN_TILE_FRACTION` floor); sidecar `tileSizes?`
  added, `tileWidth` no longer written but tolerated on read;
  `ProjectionPane.vue` renders the viewer kind via `subscribeViewerFrame` →
  `makeMat` → `FrameView` with a no-frame watchdog driving the existing
  freeze/cover machine. Codec tests live in `projection-descriptor.test.ts`
  (not the viewer-player `viewer-descriptors.test.ts`). `MIN/MAX/DEFAULT_TILE_WIDTH`
  kept exported (unreferenced) to avoid breaking the UI lane mid-flight —
  now safe to remove in a later sweep.
- **UI lane** — `.tiles` is a non-scrolling `flex` row at 100% width; tile
  widths are `flex:<fraction>` from `reconcileFractions(tileSizes, n)`;
  dividers between tiles drag `resizeAtDivider` (deltaFrac = dragPx / row
  width), persisted on release; the px width slider + scroll are gone;
  header-drag reorder unchanged (dividers go `pointer-events:none` during a
  reorder). Track theme hue drives the tile chip, a borderless-at-rest
  outline that raises on focus/highlight, `FrameView :theme`, and the
  projected pane `theme`. Each real tile carries a `{kind:"viewer"}`
  projection descriptor keyed by `tileKeyOf` (== the bridge/descriptor key);
  a window-lifetime publisher posts each wanted tile's Mat on `frameTick`.
  Instant bounce: `animateSettle` snaps to `settleTarget` immediately (150 ms
  gesture-idle debounce kept); the smooth-playhead rAF is untouched.
- `onWantedChange` wired to the publish fn (not a no-op) so a projection
  opened while paused mirrors the current frame at once.

RIG/EYEBALL (stage-f Viewer): divider drag feel + min-width floor, tiles
filling width at any track count, projection mirror correctness (playhead/3D
follow) + freeze-on-close, theme-hue balance vs saturated/disabled/master,
instant-settle snappiness.
