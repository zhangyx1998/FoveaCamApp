# Projection split-view — behavior spec

Behavioral contracts for the projection window's layout model and per-pane lifecycle.
All modules here are pure + Vue-free; the Vue shell is a thin renderer over them. Source
pointers are per section; the code carries only load-bearing invariants inline.

## Split tree {#split-tree}

Source: `app/lib/projection/split-tree.ts`
(`docs/proposals/projection-split-view.md` §"Layout model")

The layout of a projection window is a recursive tree: `Leaf(pane) | Split{ dir:
row|col, children, ratios }`, serialized into the window's URL (`?win`/state-in-URL
precedent) so reload + manifest restore replay the exact layout. Every operation is PURE
and returns a NEW tree (structural sharing not required at this scale) so the reducer is
fully unit-testable.

Invariants held on every returned tree:
- a `split` always has ≥ 2 children (a 1-child split collapses to its child; a 0-child
  split collapses to null);
- `ratios.length === children.length` and `sum(ratios) === 1` (normalized);
- a `split`'s children are never directly-nested same-`dir` splits — they are flattened,
  so a row-of-rows reads as one row (VSCode behavior).

Renderer- and main-safe, Vue-free. Addresses splits by a numeric PATH (indices from the
root) for divider resize; addresses panes by id for insert/remove/swap/find (a pane id is
stable across a reload).

## Pane termination / rebind {#termination}

Source: `app/lib/projection/termination.ts`
(`docs/proposals/projection-split-view.md` §"Termination/rebind")

Orchestrators are disposable per-app, so every app switch KILLS all projected sources.
Auto-close-on-default would then erase projections on every switch — so a pane that loses
its source does NOT terminate immediately:

```
live   --sourceLost-->      frozen(cover)   freeze the last frame, show a dismissible
                                             "source has closed" cover
frozen --sourceReturned-->  live            rebind: the next orchestrator instance
                                             connected, or the advert reappeared (new epoch)
frozen --grace elapses-->   terminated      the source did NOT come back within ~GRACE_MS
```

Only when EVERY pane is `terminated` and `projection_auto_close` is on does the window
close itself. Dismissing the cover keeps the frozen frame (status stays `frozen`, the
timer keeps running) — it only hides the note. GRACE_MS (~10s per the planner decision) is
long enough to ride out an app switch's orchestrator handoff, short enough that a genuinely
dead window auto-closes promptly. Pure + timer-injectable (unit-tests under fake timers).

## Pane descriptor codec {#descriptor}

Source: `app/lib/projection/descriptor.ts`
(`docs/proposals/projection-split-view.md` §"Sources")

A projectable pane binds ONE of three source kinds: `{kind:"frame", session, frame}` (a
Channel frame ref, driven passively by `useSession().frame(name)`), `{kind:"pipe", id}`
(an advertised SHM pipe, driven by `usePipeFrame(id)`, epoch-aware — this is what makes raw
camera previews/undistorts projectable), or `{kind:"viewer", recording, tileKey}` (a fcap
VIEWER tile — the viewer decodes in its own window, so there is no live session/pipe: the
pane MIRRORS the tile via a ref-counted same-origin `BroadcastChannel`
(`app/src/viewer/viewer-frame-bridge.ts`, `VIEWER_FRAME_CHANNEL`). The viewer re-broadcasts
the Mat a tile currently displays — playhead/3D already resolved — only for `tileKey`s a
projection has subscribed to; posts stop → the pane's freeze machine shows "source has
closed". `tileKey` is the tile identity: a channel name, or `pair:<base>` for a 3D pair.
See `docs/proposals/viewer-tiles-split-and-project.md`). This module is the VERSIONED
serialize/parse boundary for those descriptors (a single pane for the DnD payload; the whole
layout tree via split-tree.ts's `parsePane`) — `PANE_CODEC_VERSION` is 2 (v1 frame/pipe
descriptors still parse; the viewer kind is additive). Every decode is defensive — a
malformed / future-version string parses to `null` rather than throwing, so a stale URL or
foreign drag never crashes a window. Renderer- and main-safe (pure data + JSON); no Vue, no
DOM.

## Implicit projection button {#implicit-button}

Source: `app/lib/orchestrator/client.ts` (`StreamPayload`),
`app/src/components/StreamView.vue`

The project-to-window button requires NO wiring at a call site. The renderer client
stamps the stream address onto every DISPLAYED payload (`StreamPayload.source`, a
`PaneSource`) at its two ref chokepoints — `useSession().frame(name)` (`{kind:"frame"}`)
and `usePipeFrame(id)` (`{kind:"pipe"}`, re-stamped per bind so a switched selection
projects the currently-shown pipe). `StreamView` derives the `PaneDescriptor` from
`payload.source` alone, so ANY surface bound to one of these refs offers the button once
its first frame arrives.

A-P12 still holds: the stamp is client-side only, applied after receive/materialize —
the wire types (`FramePayload`/`FrameMeta` in `protocol.ts`) stay transport-only and the
address never crosses a process boundary.

Opt-out is `:projectable="false"`, used where the button must NOT appear:
- `ProjectionPane.vue` — a projection window must not offer re-projecting itself;
- `disparity-scope/Debugger.vue` — debug views whose meaning rides SVG overlays that a
  projected pane would not carry (ruled in `disparity-debugger-window.md`).

## Cross-window drag & drop {#dnd}

Source: `app/lib/projection/dnd.ts` (`docs/proposals/projection-split-view.md` §"DnD")

HTML5 drag carries a pane descriptor under a custom MIME so a drag works across Electron
windows of ONE app. This module is the PURE decision layer the Vue drag handlers call: the
effectAllowed/dropEffect + move/copy matrix (default MOVE; Alt/Option ⇒ COPY; a drag that
ORIGINATES in an app window is copy-only, because an app window's layout is rigid and its
pane must not be torn out), and the VSCode-style drop-zone geometry (edge quadrants split,
center moves/swaps). The tree mutation lives in split-tree.ts; the window-identity branching
lives in the component — this file stays pure, table-tested functions.
