# Projection split view — dedicated icon, VSCode-style panes, cross-window drag

Status: **PROPOSED (ruled 2026-07-11; dispatched).** Renderer + window-shell
work; no orchestrator/core changes expected beyond none.

## User rulings (2026-07-11, verbatim intent)

1. **Dedicated icon for stream projection.** Today StreamView/FrameView's one
   fullscreen icon does either DOM fullscreen OR opens a projection window —
   confusing. Split: one icon = element fullscreen, a DISTINCT icon =
   project-to-window (shown only with a valid projection source).
2. **Split view of multiple streams in one projection window** — VSCode
   split-pane UX as the reference: streams draggable for layout, division
   lines draggable for resizing.
3. **Cross-window drag**: StreamViews with a valid projection source drag
   across projection windows. Default semantic = MOVE to destination; a
   modifier key during drag = DUPLICATE at destination. Special case:
   dragging OUT of an app window (rigid source layout) is duplicate-only.
4. **Source termination**: panes freeze on the last valid frame and show a
   dismissible cover — "source has closed".
5. **Setting**: auto-close a projection window when ALL enclosed streams are
   terminated. Default ENABLED.

## Planner decisions (user accepted by "dispatch them all")

- **Handoff = rebind-with-grace.** Orchestrators are disposable per-app, so
  every app switch kills all projected sources. On channel death: freeze +
  cover, then attempt rebinding when the next instance connects; a pane
  counts as TERMINATED (for auto-close) only if its source does not
  reappear within a grace window (~10 s). Otherwise auto-close-on-default
  would erase projections on every app switch.
- **Sources = Channel frames AND SHM pipes.** Pane descriptor:
  `{kind:"frame", session, frame} | {kind:"pipe", id}`. Pipes ride the
  existing pipes-session/`usePipeFrame` path (epoch-aware); this makes
  camera previews/undistorts — the feeds most worth projecting — actually
  projectable (today only low-rate Channel frames are).
- **Drag grip = slim pane header** (title + grip + close, VSCode-tab-like).
  In APP windows, the projection ICON is the drag handle — canvas drags are
  steering gestures and must not be hijacked.

## Design

- **Layout model**: recursive split tree — `Leaf(pane)` |
  `Split{dir: row|col, children, ratios}` — serialized into the window's
  URL state (`?win` params precedent) so reload + manifest restore replay
  the exact layout. Divider drag mutates ratios (min pane size clamp);
  pane drop zones à la VSCode: edge quadrants split, center moves/swaps.
- **DnD**: HTML5 drag with a custom MIME (`application/x-fovea-pane+json`
  carrying the descriptor) — works across Electron windows of one app.
  `effectAllowed`/`dropEffect`: move by default, Alt/Option ⇒ copy; drags
  originating from app windows advertise copy-only. On a `move` drop the
  source window removes its pane on dragend (dropEffect check).
- **Termination/rebind**: per-pane state machine
  `live → frozen(cover) → [rebound | terminated]`; frame sources re-resolve
  on the next `orchestrator:port`, pipe sources on the advert map's epoch
  bump. Dismissing the cover keeps the frozen frame. When every pane is
  `terminated` and `projection_auto_close` (new GLOBAL config key, default
  true, Settings → Global config) is on → the window closes itself.
- **Empty window** (last pane dragged out on a move): close immediately
  (nothing to show; consistent with VSCode editor-group collapse).

## Sequencing note

Dispatched into an isolated WORKTREE while sweep Lanes B (StreamView.vue)
and D (config surfaces) finish in the main tree — the planner reconciles
the two overlap regions (StreamView titlebar block; the config key, which
moves onto Lane D's config-schema module if that lands first) at
integration.

## Verification (software)

- vitest: split-tree reducer (insert/remove/resize/serialize round-trip),
  descriptor codec, termination/rebind state machine (fake timers), DnD
  intent resolution (move/dup/app-window cases) as pure logic.
- vue-tsc + vite build; boundary greps (all renderer-side).
- RIG/manual: drag feel vs VSCode reference, cross-window move/dup with the
  modifier, app-switch grace rebind, auto-close toggle, frozen-cover
  dismiss, layout surviving reload.
