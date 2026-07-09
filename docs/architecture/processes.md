# Processes, boundaries, and build entries

> Source of truth: `app/electron/main.ts`, `app/orchestrator/index.ts`,
> `app/electron/preload-renderer.ts` / `preload-profiler.ts`,
> `app/vite.config.ts`, `core/Addon.cpp`.

## 1. Process map

| Unit | Runs | Owns |
|---|---|---|
| **Electron main** | `electron/main.ts` | Window manager + manifest restore, the orchestrator fork, port brokering, dialogs/shell |
| **Orchestrator** | `utilityProcess` fork of `.dist/electron/orchestrator.js` (`orchestrator/index.ts`) | `core` (the native addon), cameras, serial controller, sessions, the store, SHM pipe brokering. **The only process that touches Aravis** — GigE camera access is per-process exclusive. |
| **Renderer windows** | one `BrowserWindow` per entry (`docs/architecture/windows.md`) | Vue UI only. **Core-free** (type-only imports allowed). Pixels arrive via SHM pipes or session frame topics. |
| **Vision workers** | `worker_thread` per vision session, bundled `.dist/electron/vision-worker.js` | Per-session pixel work (KCF, warp, diff, detection kernels) off the orchestrator loop; SHM-reads camera pipes directly. |
| **Recorder worker** | `worker_thread` | `.fcap` MCAP writing (`recorder.md`). |
| **Viewer worker** | `worker_thread` per viewer WINDOW (spawned by `preload-viewer.cjs`; bundled `.dist/electron/viewer-worker.js`) | STANDALONE recording playback: MCAP read + core-Vision decode + pacing, entirely inside the window's process — never touches the orchestrator (`recorder.md` §3). The scoped, ruled exception to the core-free-renderer rule. |
| **Native threads** (inside the orchestrator process, owned by `core`) | Arv capture sinks, format converters, undistort remap, KCF tracker, SHM pipe publishers | Free-running per-frame work; each exposes a meter block the orchestrator probes out-of-loop (`metering.md`). |

## 2. Boundaries (the two greps)

Two lint-by-grep rules keep the bundles honest; CI-equivalent checks run at
every task boundary (`docs/dev/gates.md`):

- **Orchestrator-reachable code is Vue-free.** Nothing under
  `app/orchestrator/` or imported by it may import `vue`. (The one deliberate
  exception: `app/lib/orchestrator/client.ts` is the RENDERER-side session
  client and is never orchestrator-reachable.)
- **The renderer is core-free.** No renderer file imports `core` at runtime;
  `import type { … } from "core/..."` is fine (erased at compile). All
  hardware/vision access goes through an orchestrator session or an SHM pipe.

## 3. Ports and handshakes

- A renderer asks `orchestrator:connect` (preload bridge → main). Main creates
  a `MessageChannelMain` pair, posts one end to the orchestrator as
  `{ type: "channel:connect", windowId }` (the sender's stable window id —
  authoritative, keyed off `event.sender`; a renderer cannot spoof it), and
  the other end to the renderer. `Hub.attach(port, { windowId })` tags the
  channel — `hub.windowIdOf(ch)` is the per-window key used by composition
  validation (`stream-graph.md`).
- **Window drain:** main sends `{ type: "window:drain", id }` before an app
  switch; the orchestrator idles every camera-owning session and answers
  `window:drain-result` (`{ok:false}` = refused: mid-capture/recording — V1).
- **Window closed:** main sends `{ type: "window:closed", windowId }` when a
  BrowserWindow is DESTROYED (not on reload — a reload closes the port but
  the windowId lives on). `hub.onWindowClosed(fn)` hooks run per-window
  teardown (composed node namespaces).

## 4. Preload rules — the V11 triplet

Preloads are built by the low-level `vite-plugin-electron` with **one build
per entry** and explicit lib config. Violating any of these reproduces a
documented boot failure (root-cause transcripts:
`docs/history/refactor/preload-error.md`):

- **V11** — modules shared between preloads are inlined into each output,
  never split into sibling chunks: a sandboxed preload cannot `require` a
  sibling chunk.
- **V11b** — preload output is CJS named `.cjs`: unsandboxed preloads load
  `.mjs` as real ESM, where bare `require` throws. The lib `formats: ["cjs"]`
  is explicit because the plugin otherwise derives ESM from the package
  `type` and emits ESM into a `.cjs` file.
- **V11c** — never `createRequire(import.meta.url)` in a preload: vite's CJS
  shim resolves `import.meta.url` via `document.baseURI` (preloads have a
  `document`), yielding the dev-server http URL, which `createRequire`
  rejects. Preload bundles use the module wrapper's own `require`.

Preload kinds are part of the window taxonomy (`windows.md`): `renderer`
(bridge + SHM reader addon, `sandbox: false`) and `profiler` (sandboxed,
bridge only).

## 5. Build entries

`app/vite.config.ts` drives everything:

- **Window HTML is generated**, not hand-written: the `foveaWindowEntries`
  plugin emits `app/windows/<key>.html` (gitignored) from the `@lib/windows`
  registry on every `buildStart` — shared head/body template + one inline
  script calling `bootEntry("<key>")`. Adding a window = one registry row
  (`windows.md` §6).
- **Electron entries:** `main`, `orchestrator`, and `vision-worker` build
  through the same mechanism with `rollupOptions.external: isExternal` —
  `core` and every `dependencies` package (plus subpaths) stay external so
  native addons resolve at runtime. Consequence: **renderer-bundled libraries
  belong in `devDependencies`** (a `dependencies` entry gets externalized and
  CJS-flagged for the renderer, breaking the bundle).
- **HMR boundary:** any hot update whose invalidation chain reaches
  `lib/orchestrator/**`, `lib/store.ts`, or a module `contract.ts` escalates
  to a full page reload — hot-swapping wire/protocol code in a renderer while
  the orchestrator runs old code would desynchronize the channel.
