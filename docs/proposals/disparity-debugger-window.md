# Disparity-scope debugger window (module-owned debug sub-window)

Status: **SHIPPED (code-complete 2026-07-09, `fc9ac30`; rig pass owed —
`hardware/stage-f.md` §"Disparity debugger window")**. Follow-up to
`stereo-disparity-and-heatmap-nodes.md` — the main UI sheds its inline debug
strip; the WS2 2b `debug` window class gains its first real user.

## The rulings (user, 2026-07-09, verbatim intent)

1. **Remove the 3 debug StreamViews entirely from the disparity-scope main
   UI** (the `.divergence` block: "Template Match Guide Strip" + "Left Match"
   + "Right Match").
2. **Replace with a button at the bottom of column 2** (the CENTER camera
   column of `.cameras`, below the vergence `.report` line) **that toggles a
   debugger window.**
3. **The debugger window loads a main component `Debugger.vue` from the same
   directory as the module's main vue component**
   (`app/modules/disparity-scope/Debugger.vue`), is a **utility window, and is
   exempt from the exclusive rule** (never drains/switches the app, never
   counts for the welcome rule).
4. **Purpose of the debug views = vertical stack, pixel-COLUMN
   cross-reference**: top row is the match strip; rows 2 and 3 are the match
   score of each strip pixel against the left/right needle. **The original
   code padded rows 2/3 so the columns align exactly — restore that.**
   (Legacy reference: `c582c8d` `processMatch` padded the correlation map via
   out-of-bounds `slice` before `heatmap` — but over-wide by one needle
   width; we pin the exact version below.)

Context for ruling 1–2 (the "fullscreen confusion"): the projection button on
a StreamView falls back to element-fullscreen when the view has no
session-frame `source` (pipe-backed views like the guide strip) — it used to
open a projection window when these views rode session frames. The debugger's
views set `:projectable="false"` so the button disappears instead of
misbehaving.

## Design (pinned)

### A. Kernel-side heatmap alignment (`app/orchestrator/template-match-kernel.ts`)

The emitted `match` heatmap must have EXACTLY the haystack's dims, with each
heatmap pixel (x, y) = the score of the needle CENTERED at haystack pixel
(x, y):

- Compute `values` (minMaxLoc, rect, score) on the UNPADDED map exactly as
  today — peak/rect math stays map-local (top-left placement space).
- For the emitted frame only: pad the (post-gaussian) map to the haystack
  dims with the zero-filling out-of-bounds `slice` (core `Vision.cpp` fills
  out-of-range with zeros — the legacy code relied on this):

  ```ts
  // map is (sh-th+1) × (sw-tw+1); pad so pixel (x,y) = needle CENTERED at
  // haystack (x,y): top-left placement x - floor(tw/2), zero border = neutral.
  const padded = slice(map, { x: -Math.floor(tw / 2), y: -Math.floor(th / 2),
                              width: sw, height: sh });
  ```

  then `heatmap(padded)` as the `match` frame. Zero score renders as the
  neutral mid color — acceptable and matches the legacy look.
- This is generic kernel behavior (no params, no app leakage): the map is a
  diagnostic and its only consumer wants haystack-aligned columns. Update the
  kernel's header comment + `emitHeatmap` doc line accordingly.
- The haystack here is the SCALED strip (`scale/match` ratio `s`); the
  debugger's top row is the FULL-RES strip slice. Same aspect ⇒ rendering all
  rows at the same CSS width aligns columns exactly. No renderer-side math.

### B. Debug window = module component (reshape the empty WS2 2b substrate)

`DEBUG_OVERLAYS` never gained a user — reshape rather than extend:

- **`app/src/windows/debug-registry.ts`**: session → component loader, the
  `app-registry.ts` pattern:

  ```ts
  const debugLoaders: Record<string, Loader> = {
    "disparity-scope": () => import("@modules/disparity-scope/Debugger.vue"),
  };
  ```

  Drop the `DebugOverlay` contract/overlay shape (zero users, grep-verified).
- **`app/src/windows/DebugWindow.vue`**: thin shell — resolve the loader by
  `session`, mount it full-window under the TitleBar (title "Debugger",
  subtitle = session name). Delete the frame/pipe address + overlay logic
  (the module component owns its own subscriptions). Keep the "no debugger
  registered for <session>" notice.
- **Bridge**: `toggleDebugWindow(session: string)` — drop the `frame` arg
  end-to-end: `bridge.ts` (`FoveaBridge` + `SendChannels["window:toggle-debug"]`),
  `preload-bridge.ts`, `main.ts` `onRenderer` handler.
- **`window-manager.ts`**: `toggleDebug(session: string, owner)` — search
  `?session=…`, key `debug:<session>`, owner = current app window (cascade
  unchanged). `ProjectionParams` remains projection-only.
- **`boot-entry.ts`**: debug props → `{ session: readUrlParam("session") ?? "" }`.
- **`lib/windows.ts` `WINDOWS.debug`**: comment rewritten (module debugger
  component, not annotation overlay), title `FoveaCam Duo — Debugger`, bounds
  sized for 3 stacked strips (`width: 1080, height: 640, minWidth: 480,
  minHeight: 320`). The class already IS the ruling's exemption: `exclusive:
  false`, `countsForWelcome: false`, `onOwnerClose: "cascade"` (closes with
  the opener app — its session dies with it). Class name stays `debug`.

### C. `app/modules/disparity-scope/Debugger.vue` (new)

- Passive contract subscription: `useSession(disparity, "disparity-scope",
  { passive: true })` — never activates (the app owns the session).
- Row 1: strip pipe `usePipeFrame(() => state.serials?.C ?
  nodeId.slice(state.serials.C, "scope-strip") : null)` with the SAME overlay
  rects the main UI's guide strip carried (match_center fill,
  match_left/match_right stroke rects — move that markup here verbatim).
- Rows 2–3: `useFrames(session, ["match_left", "match_right"])`, titles kept
  ("Left/Right Match (Red = Match, Blue = Mismatch)").
- Layout: the 3 StreamViews stacked vertically, each `width: 100%`, in one
  column — same container width ⇒ exact column alignment (per §A). No gaps
  between rows beyond the StreamView title chrome. `:projectable="false"` on
  all three. Graceful "waiting" state while frames are absent.

### D. `app/modules/disparity-scope/index.vue` (main UI)

- DELETE the whole `.divergence` template block + its style rule + the now
  unused bindings: `frameStrip`, `frameMatchLeft`/`frameMatchRight` (and the
  `useFrames` import if nothing else uses it). The drawer `paddingBottom`
  interplay rode `.divergence` — drop it with the block (the drawer overlays;
  nothing else needs the spacer). Keep `drawer_height` only if still used.
- ADD at the bottom of the center `.view` column (below the `.report` div): a
  "Debugger" button calling
  `window.foveaBridge.toggleDebugWindow("disparity-scope")` (see
  `FrameView.vue:97` for the bridge-call pattern). Style consistent with the
  existing chrome (the `.reset`-button look is fine).

### E. Tests + gates

- `app/test/window-manager.test.ts`: update `toggleDebug` for the new
  signature; add/adjust: toggle-on spawns class `debug` keyed
  `debug:<session>` with owner = app window; toggle-off closes it; cascade on
  owner close still covered by the existing 2a tests.
- Gates (from `app/`): `../node_modules/.bin/vue-tsc --noEmit`,
  `../node_modules/.bin/vitest run`, `../node_modules/.bin/vite build` at
  close. NO core/ changes in this wave (`slice` already supports the padding).
- NEVER launch Electron; UI behavior lands on the stage-f rig checklist.

### Non-goals

- No on-demand gating of the match heatmap emission (`emitHeatmap` stays
  always-on): the match kernels must run regardless (they feed the vergence
  PID), so the marginal cost is one `heatmap()` per tick. Revisit only if the
  session gains frame-channel subscriber observability.
- No change to the projection window or the fullscreen fallback itself.

## Rig items (stage-f)

Debugger button toggles the window open/closed; window cascades closed when
the app window closes or switches; opening it does NOT drain the session
(exclusivity exemption); the three rows column-align (a feature at strip
column x shows its score peak at the same display column in rows 2/3);
`:projectable="false"` — no projection/fullscreen button on the debug views;
main UI no longer shows the inline strip.

## AS SHIPPED (2026-07-09, commit fc9ac30)

Implemented as ruled (worker-built, planner-verified). Deltas/notes:

- §D button wiring: the bridge call lives in a script `openDebugger()`
  handler (Vue templates don't expose `window`), matching every existing
  bridge caller.
- Debugger row 1 keeps the "Template Match Guide Strip" title (proposal only
  pinned rows 2/3); `DebugWindow` shell scrolls (`overflow: auto`) instead of
  centering, since the stack is taller than one frame.
- `drawer_height` stayed in `index.vue` (still the Drawer v-model); only the
  `.divergence` spacer went.
- Gates at close: vue-tsc 0; vitest 458/458 (window-manager toggleDebug tests
  updated to the single-arg signature + a search-carries-session-only
  assertion); vite build 0 (orchestrator 245.68 kB unchanged).
- Rig pass owed: stage-f §"Disparity debugger window".
