# Plan: Multi-Window Architecture (Stage 5, items 1–2)

> **Status:** **Round 1 landed & planner-accepted 2026-07-06** (A-6/A-7):
> window manager + welcome rule + drain-aware exclusivity (main↔orch
> `window:drain` handshake, busy refusal, 10 s timeout), 13 per-app
> entry HTMLs off a shared `lib/windows.ts` catalog, welcome window
> (launcher + status + params + SVG `Annotation` overlay — percent
> coords, stable ids, ready for user positioning), window manifest +
> dev Cmd-Shift-R full restart+restore, plain Cmd-R blocked app-wide →
> `recorder:trigger` stub, shared TitleBar chrome with the fullscreen
> fix (root cause: rect recompute only on `resize`, which fires
> mid-transition — now `geometrychange` + forwarded fullscreen events).
> 23 new tests. **GUI smoke pending (user).**
> **Round 2 A-side landed & accepted (2026-07-06):** projection
> windows (0..N passive single-stream viewers off the StreamView/
> FrameView expand button; frame *address* via a client-side-only
> `FrameMeta.source` stamp — no prop threading, never on the wire;
> frozen-frame + idle overlay; manifest round-trips `?session=&frame=`);
> `lib/url-state.ts` state-in-URL helper (**deviation, ratified: query
> string, not path subpath — subpaths break packaged `file://`
> loading**) adopted in calibrate-extrinsic (`?step=`) + projections;
> `hmrBoundary()` vite plugin (req. 8 — importer-closure walk,
> serve-only); legacy `index.html`/`App.vue`/`src/index.ts` deleted;
> bonus: utility-only manifests now respect the welcome rule.
> 12 new tests (141 total).
> **Remaining queue:** direct app→app switch affordance (currently
> back-to-home → pick; user to decide if a direct switcher is wanted);
> GUI smoke of rounds 1+2 (user).
> **Owner:** Yuxuan (direction) / planner (spec) / coder threads (impl).
> **Related:** [`orchestrator.md`](./orchestrator.md) (window-relevant
> substrate: shm multi-reader §4, passive subscriptions V12, `finterest`
> C10, per-entry build lesson V11), [`workload-metering.md`](./workload-metering.md),
> [`recorder-container.md`](./recorder-container.md) (viewer windows).

## 1. Requirements (user, 2026-07-06)

1. **Welcome window** — shown whenever there is no open *application*
   window. Utility windows (profiler; projection windows; recorder
   viewer windows) do not count toward that rule.
2. **One window per app** — each app (manage-cameras, tracking-single,
   disparity-scope, manual-control, multi-fovea, calibrate-*, …) runs
   in its own window with a **separate entry URL and entry HTML**.
3. **App exclusivity** — apps are mutually exclusive (their sessions
   conflict over camera leases and the controller): at most one app
   window open at a time, enforced at spawn.
4. **Projection window** — the current "full screen" button on
   StreamView/FrameView spawns a dedicated single-stream viewer window;
   **defaults to windowed mode, resizable to fullscreen**.
5. **Welcome window content (user addendum, 2026-07-06):** shows
   connection status and basic camera params (resolution, fps, gain,
   exposure, …) **annotated on a live camera image** via an **SVG
   canvas overlay** — the user will personally position the
   annotations; coders build the canvas + data plumbing. All shown info
   is **synced from the orchestrator** (single source of truth).
6. **Refresh semantics (user addendum, 2026-07-06; revised same day):**
   reload is **Ctrl/Cmd-Shift-R**, **dev-mode only**, and restarts
   **everything** — main process AND orchestrator — then restores the
   exact pre-refresh window layout (open windows, positions, and each
   window's landing URL). **Plain Ctrl/Cmd-R is reserved for
   triggering the recorder** (all modes) and must never reload.
7. **Stateful windows expose internal state in their URL** (e.g.
   calibrate-extrinsic's wizard step as a subpath), so refresh/restore
   lands back in the same internal state, not just the same window.
8. **HMR policy (user addendum, 2026-07-06):** Vite HMR is allowed in
   renderer windows **only when the hot update does not involve the
   protocol layer**; otherwise fall back to a full reload. (Rationale:
   protocol modules hold live wire state — hot-swapping them in place
   desyncs the renderer from the running orchestrator.)
9. **Custom titlebar fullscreen bug (item 2)** — the custom titlebar
   misbehaves in fullscreen and stays broken after returning to
   windowed mode. Fix belongs in the shared window-chrome layer this
   stage creates; the projection window's windowed↔fullscreen toggle is
   the natural stress test.

## 2. Window taxonomy (planner)

| Class | Instances | Counts for welcome rule | Exclusive | Preload |
|---|---|---|---|---|
| Welcome | singleton | n/a (it IS the fallback) | n/a | `preload-renderer.cjs` (addendum: live annotated previews ⇒ needs the shm reader, `sandbox: false`) |
| App | ≤ 1 at a time | yes | yes | `preload-renderer.cjs` (bridge + shm reader, `sandbox: false`) |
| Projection | 0..N | no | no | `preload-renderer.cjs` (needs shm reader) |
| Profiler | singleton | no | no | `preload-profiler.cjs` (sandboxed, bridge only) |
| Recorder viewer | 0..N (one per file) | no | no | TBD in recorder-container.md (file reads via bridge or main) |

## 3. Design notes (planner, to be firmed into specs)

- **Main process owns the window state machine**: registry of open
  windows by class; welcome spawn/despawn on app-window transitions;
  exclusivity enforcement (opening app B while A is open → defined
  policy, see open decisions). This subsumes today's ad-hoc
  `openProfilerWindow` handler.
- **Per-app entry HTML/URL** = multi-entry renderer vite build. Apply
  the V11 lesson deliberately: per-entry outputs must be checked for
  cross-entry chunk assumptions (renderer entries MAY share chunks —
  they're http-served pages, unlike sandboxed preloads — but entry
  wiring, dev-server URLs vs file paths per window, and the
  orchestrator port handshake per window all need explicit design).
  Every window gets its own MessagePort brokered by main (already the
  architecture — objective #2's "multiple renderers" was designed in
  from the start; C10 `finterest` + shm multi-reader make per-window
  cost near-zero).
- **App switching interacts with V1 drain**: closing app A's window
  must run the same graceful idle (stop recording, drain capture,
  release leases) before app B's window may activate its session.
  Exclusivity enforcement must therefore be *async-aware* — "closed"
  means drained, not just window-destroyed.
- **Projection windows subscribe passively** (V12 mechanism) so a
  viewer never activates/keeps-alive a session, and declare `finterest`
  on exactly one topic (C10's designed payoff). Zero marginal producer
  cost per Stage 4's multi-reader shm design. Open question: behavior
  when the source session idles (frozen last frame + overlay note is
  the proposed default).
- **Titlebar/window chrome**: one shared chrome component used by all
  window classes; main forwards `enter-full-screen`/`leave-full-screen`
  to the renderer via new `foveaBridge` surface; chrome adjusts
  traffic-light inset + drag regions (`-webkit-app-region`) on both
  transitions (the current bug is the missing/one-way restore path).

## 4. Design notes for the 2026-07-06 addenda (planner)

- **Welcome previews vs exclusivity:** showing live camera images on
  the welcome window means the welcome subscribes to preview streams —
  it should do so **passively where possible** but does need the
  registry preview loop running, which makes welcome a *camera-holding*
  window. The welcome→app transition therefore rides the same
  drain/handoff path as app→app switching (RT1/V1 class): welcome
  releases (or its session idles) before the app acquires. Camera
  *params* (resolution/fps/gain/exposure) come from the same
  orchestrator surface manage-cameras already reads — no new source of
  truth; a lightweight `welcome` session (or reuse of manage-cameras'
  read-only surface) fans it to the SVG overlay.
- **SVG annotation canvas:** coders deliver the canvas component
  (SVG layer over the preview, data-bound annotation elements with
  stable ids/anchors) + the synced data plumbing; **the user does the
  visual positioning himself** — build for hand-editability (clean
  markup, one annotation = one element, no generated soup).
- **Dev-mode full-restart refresh:** the accelerator is
  **Ctrl/Cmd-Shift-R** (plain Ctrl/Cmd-R is the recorder trigger — see
  recorder-container.md — so the default reload accelerator must be
  unregistered/blocked in ALL modes, not just production, and rebound
  to the recorder action). Main intercepts Cmd-Shift-R (registered
  only when dev); on trigger: persist the
  window manifest (window class + landing URL incl. state subpath +
  bounds for every open window) through the store, then relaunch the
  whole app (`app.relaunch()` + exit — orchestrator dies with main and
  boots fresh); on startup, if a restore manifest exists (dev), spawn
  that layout instead of the default welcome. Production builds:
  accelerator not registered; renderer-initiated reloads blocked.
- **HMR boundary (addendum 8):** the danger class is *stateful
  singletons and shared wire code*: `lib/orchestrator/**` (Channel,
  client `connect()`'s module-level channel promise, shm read pool,
  protocol types compiled into BOTH renderer and orchestrator bundles),
  `lib/store.ts`, module `contract.ts` files. Hot-patching any of these
  in the renderer while the orchestrator keeps running old code = wire
  mismatch, duplicated subscriptions, leaked ports/pools. Mechanism: a
  small vite plugin (or `import.meta.hot.decline()` markers) declares
  these modules HMR-ineligible so any update whose invalidation chain
  reaches them escalates to full reload; plain Vue SFC/UI updates keep
  hot-reloading as today. Note protocol-file edits also rebuild the
  orchestrator (vite-plugin-electron watch) → electron restarts → the
  reload converges with the dev restart+restore flow (window manifest);
  the two addenda share the restore mechanism.
- **State-in-URL:** the orchestrator/session remains authoritative;
  the window keeps its URL subpath in sync with session state
  (renderer updates `history.replaceState` on state change) and, on
  load, the URL seeds the session (e.g. calibrate-extrinsic
  `enterStep` — its scratch-store resume already exists; the URL
  becomes the address of that state, not a second copy of it).

## 5. Open decisions (defaults proposed; user can veto)

1. Welcome window on app open: **close** (respawn on last-app-close)
   vs hide. Proposed: close — simpler lifecycle, spawn is cheap.
   Note the addendum makes welcome camera-holding, so close now also
   means "release previews" — consistent with the drain design.
2. Opening app B while app A is open: **switch** (drain A, then open B)
   vs refuse-with-focus. Proposed: switch, with a busy indicator during
   drain; refuse only if A is mid-capture/recording (surface a prompt).
3. Projection windows on parent-app close: **stay open** showing the
   frozen last frame (they're passive; stream resumes if the topic
   comes back) vs close-with-app. Proposed: stay open.
4. ~~Welcome content scope~~ **Resolved by the 2026-07-06 addendum:**
   launcher + connection status + live annotated preview (SVG canvas,
   user-positioned).

## 6. Sequencing

Foundation for the rest of Stage 5: recorder viewer windows
(recorder-container.md) and profiler reorganization
(workload-metering.md UI half) both build on the window framework.
Suggested internal order: (a) main-process window manager + welcome +
per-entry build, (b) chrome/titlebar fix, (c) projection windows,
(d) exclusivity/drain integration. Split A-heavy; C touches only if
shm-reader preload wiring needs changes.
