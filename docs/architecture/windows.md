# Windows: taxonomy, manager, identity

> Source of truth: `app/lib/windows.ts` (the catalog), `app/electron/
> window-manager.ts`, `app/electron/window-manifest.ts`,
> `app/src/windows/boot-entry.ts`, `app/lib/url-state.ts`.

## 1. Taxonomy

`WINDOWS` in `@lib/windows` is the single source every consumer derives from
(manager, options adapter, manifest planner, vite entries):

| Class | Cardinality | Preload / sandbox | Notes |
|---|---|---|---|
| `welcome` | singleton | renderer / unsandboxed | The launcher; reappears whenever zero app windows are open (the **welcome rule**) |
| `app` | ≤ 1 via **exclusivity** | renderer / unsandboxed | Apps are mutually exclusive over camera leases + the controller; switching drains first |
| `profiler` | singleton | profiler / **sandboxed** | Bridge-only (no SHM reader); passive over sessions (V12) |
| `projection` | 0..N | renderer / unsandboxed | Single-stream viewers; survive their source app's close (frozen last frame) |
| `viewer` | 0..N, one per file | renderer / unsandboxed | `.fovea` playback; `fileKey` dedupe |
| `debug` | 0..N, keyed toggle | renderer / unsandboxed | Owner-bound sub-window; the only `onOwnerClose: cascade` class |

`owner` + `onOwnerClose` (cascade|survive) generalize sub-windows: apps own
0..N aux windows; cascade children close with their owner, grandchildren
recursively.

## 2. Manager

`WindowManager` (pure logic, unit-tested with fakes; main.ts adapts real
BrowserWindows):

- **One spawn chokepoint** — every open path routes through the private
  `spawn()` (identity minting, §3).
- **Drain-aware switching** — `openApp` serializes switches; existing
  app/welcome holders are DRAINED (orchestrator sessions idle, V1) before
  their windows close; a busy session refuses the switch and the user is
  notified. "Closed" = session-idle-drained.
- **Toggle primitive** — keyed open-or-close (the debug drawer);
  `openViewer` per-file dedupe is the same idea with focus-on-existing.

## 3. Stable window identity (`?win=`)

Every window instance has a manager-minted id `<appId|class>-<n>`, unique
among live windows:

- Threaded into the window URL as `?win=` (`WINDOW_ID_PARAM`) — the renderer
  reads its own identity via `windowId()` from `@lib/url-state`; it survives
  reloads and manifest restores (the manifest persists the landing URL and
  the manager recovers the id instead of re-minting; fresh mints probe the
  live set to dodge collisions).
- Main tags each orchestrator channel with the sender's id at the connect
  handshake (authoritative — `processes.md` §3) → `hub.windowIdOf(ch)`.
- On BrowserWindow destroy main sends `window:closed` → `hub.onWindowClosed`
  hooks tear down the window's composed graph namespace
  (`stream-graph.md` §5). A reload does NOT fire this — the id lives on.

## 4. State-in-URL

Stateful windows expose their address/state in the query string
(`lib/url-state.ts`): projections/debug carry `?session=…&frame=…`, viewers
`?path=…`, every window `?win=…`. The orchestrator session stays
authoritative — the URL is the *address* of state, not a copy; components
sync with `history.replaceState` and read once on load. The query string is
the one URL slot that works identically on the dev server and packaged
`loadFile`.

A `frame` address may also be `pipe:<pipeId>` — the debug window binds pixels
via `usePipeFrame` instead of a session frame topic when so addressed.

## 5. Manifest restore

Ctrl/Cmd-Shift-R (dev) persists `{class, url, bounds}` for every open window,
relaunches the whole app, and startup replays the plan. `planFromManifest`
(pure, unit-tested) re-enforces the live invariants — one app window max,
singletons, unknown classes dropped, welcome fallback. Restored URLs carry
state params + window ids, so windows land back in their exact pre-restart
state. The manifest is read/written by MAIN directly (the orchestrator is
dead at persist time and unbooted at consume time).

## 6. Entry generation

Window HTML is generated from the registry (`processes.md` §5): entry keys =
window-class names + app ids; `boot-entry.ts` maps a key to its root
component (special classes) or the shared `AppWindow` shell (app ids, which
resolve their module component via `app-registry.ts`). Adding a window = one
registry row; the pre-mount OS title also derives from the registry
(`entryTitle`).
