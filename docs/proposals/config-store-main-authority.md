# Config store: MAIN as the single authority

Status: **CODE-COMPLETE (2026-07-10) — proposal + implementation + tests
landed in one wave; rig/live multi-window pass owed (stage-f §Settings).**

Fixes the four config-store synchronization defects a review (2026-07-10)
found in the per-instance store-hub: the hub's cache + listeners were
per-orchestrator-process, so two live instances (a settings instance and a
hardware instance) each shadowed the same disk file and never saw each
other's edits, and every renderer write was a whole-document clobber from a
possibly-stale per-process cache.

## Current topology (the four defects)

Before this change the authority lived in `app/orchestrator/store-hub.ts`,
one copy PER orchestrator process:

- **D1 — cross-instance blindness.** `store-hub` holds a per-path cache +
  listener set. With a non-hardware "settings" instance AND a hardware
  instance both alive (`main.ts` `ensureSettingsInstance`), two hubs shadow
  the same on-disk file; an edit routed to one hub's cache never reaches the
  other's listeners. Windows on different instances silently diverge.
- **D2 — silent clobber.** The renderer `Store` always wrote the WHOLE
  document (`app/lib/store.ts` `store:write`; hub `write()`), computed from
  that process's cache. A write from a stale cache reverts keys another
  instance persisted, with no error.
- **D3 — dead-channel decay.** The renderer→orchestrator `connect()` is
  one-shot (reconnect out of scope). A Settings/TeleCanvas window outliving
  its backing instance kept mutating a local reactive object whose writes
  went nowhere — silent data loss.
- **D4 — last-write-wins cross-key races.** Two windows on ONE instance
  writing DIFFERENT keys inside one RTT clobbered each other, because both
  sent whole-document writes.

## Target topology

**MAIN is the single config authority** — it is the only always-alive
process (precedent: the `telecanvas:target` broker, b95a1d4). Everything
else is a thin client over an UNCHANGED public API; only the transport
behind `Store` (renderer) and `store-hub` (orchestrator) changes.

```
                         ┌───────────────────────────────┐
                         │            MAIN                │
                         │  StoreMain  →  StoreAuthority  │
                         │  (cache + serialized ops +     │
                         │   notify-except-origin)        │
                         │        ↓ fs (store.ts codec)   │
                         │        disk  <store>/*.json    │
                         └───┬───────────────┬───────────┘
              ipcMain        │               │  parentPort
        (structured clone)   │               │  (utilityProcess)
        ┌────────────────────┴──┐         ┌──┴─────────────────────┐
        │  renderer windows      │         │ orchestrator instances │
        │  Store.open/read/…     │         │  + probe               │
        │  (Vue-reactive, patch) │         │  store-hub read/write/ │
        │                        │         │  update/subscribe/…    │
        └────────────────────────┘         └────────────────────────┘
```

- **Authority core** (`app/lib/store-authority.ts`, pure, fs injected):
  the per-path cache, the per-doc serialized op queue, and
  notify-except-origin — i.e. exactly the old `store-hub` core, minus any
  transport, plus a key-level `patch`. Unit-tested with an in-memory fs.
- **fs codec** (`app/orchestrator/store.ts`, reused verbatim; same on-disk
  JSON layout + `@lib/store-codec`, zero migration). Its store root now
  resolves `FOVEA_DATA_PATH` LAZILY per call so main (which sets the env at
  body top) can drive it without an eval-order trap.
- **StoreMain** (`app/electron/store-main.ts`): wires the authority to two
  transports — ipcMain for renderer windows, and a `store:req`/`store:res`
  + `store:changed` message protocol over each child's `parentPort` for
  orchestrator instances AND the probe. Tracks one authority subscription
  per (client, path); origin never receives its own echo.

## Patch protocol (kills D2 + D4)

The renderer `Store.open(...)` tracks a Vue-reactive doc as before. On a
deep change it DIFFS the tracked doc against its last-acked snapshot at
TOP-LEVEL-KEY granularity and sends a PATCH (a list of ops), not a whole
document:

- `{ key, value }` — set/replace a top-level key (a nested change replaces
  the whole key value; that is the granularity).
- `{ key, remove: true }` — delete a top-level key.
- `{ replace: value }` — whole-doc replace, emitted only when the doc is an
  array or a non-plain-object (rare; arrays are not the multi-writer case).

Main merges the patch into the authoritative doc (`applyOps`), persists,
and broadcasts the full merged value to every OTHER subscriber. Concurrent
writers to DIFFERENT keys both survive; same-key stays last-write-wins
(acceptable). The microtask write debounce + the `applying` echo guard are
preserved. `diffKeys`/`applyOps`/`deepEqual`/`replaceInPlace` live in the
pure `app/lib/store-patch.ts` (unit-tested).

Orchestrator-internal writers keep their exact API: `write` (whole-doc),
`update` (set-merge), `clear`. They forward to main and locally apply the
value main returns, so this instance's own `subscribe()` listeners
(anaglyph-style retune, etc.) still fire.

## Echo / ordering guarantees

- **Serialized per doc.** The authority runs a per-path FIFO (unchanged
  from the old hub), so broadcasts reflect committed values in order.
- **Echo-skip.** Each client (a renderer webContents, an orchestrator
  instance, the probe) has ONE authority listener per subscribed path. A
  client's own write/patch passes that listener as `except`, so an
  originator is never notified of its own change (it already applied it
  optimistically). Mirrors the old `ServerSession.setState` origin skip.
- **Cross-instance delivery.** A renderer edit on instance A's window and
  an orchestrator subscriber on instance B both hang off the SAME main
  authority, so B's `subscribe()` fires live — D1 gone by construction.

## Settings-instance retirement (kills D3 structurally)

**Decision: RETIRE the non-hardware "settings" instance.** Evidence: the
Settings (`ConfigBody.vue`) and TeleCanvas (`TeleCanvasBody.vue`) windows
consume only (a) `Store` / `useConfigRef` / `calibration-data` — all now
main-backed — and (b) `window.foveaBridge` for probe cameras + TeleCanvas
host status/target (already main-brokered). Neither window ever calls
`useSession`/`useController`/`connect()`. With `Store` talking to main, they
need NOTHING from an orchestrator instance, so main no longer forks one to
"back the store" from Welcome. Removed: `settingsInstanceId`,
`settingsConsumers`, `ensureSettingsInstance`, `acquire/releaseSettingsInstance`,
and the config/telecanvas `win.on("closed")` release hooks. A store
connection can no longer die with an instance — the decay class is gone.

`OrchestratorInstances.connectTarget()` keeps its newest-live-non-hardware
fallback (a future viewer compute instance may use it); only its doc comment
loses the settings reference.

## Transport changes (surface map)

- `app/lib/store.ts` (renderer): `open/clear/list/read` unchanged
  signatures + reactive semantics; transport re-targeted from the
  orchestrator `Channel` to `window.foveaBridge` (ipcRenderer). It no longer
  imports `connect()` — structurally cannot capture a dying channel (D3).
- `app/orchestrator/store-hub.ts`: `read/write/update/clear/list/subscribe/
  writeCounts` unchanged signatures; body is now a `parentPort` proxy to
  main. `attachStore` REMOVED (renderers no longer route store ops through
  the orchestrator channel); `runtime.ts` drops the `attachStore(ch)` call.
- `app/electron/bridge.ts` + `preload-bridge.ts`: new invoke channels
  `store:read`, `store:read-once`, `store:patch`, `store:clear`,
  `store:list`; new push `store:changed`; new `foveaBridge` methods
  `readStore/readStoreOnce/patchStore/clearStore/listStore/onStoreChanged`.
- `app/electron/main.ts`: instantiate `StoreMain`; register the store IPC
  (sender-aware); route each child's `store:*` messages through
  `attachProcess` in `forkInstance` (orchestrator) + `spawnProbe` (probe);
  retire the settings instance; set `FOVEA_DATA_PATH` for main's own fs.

## Migration / compat

- On-disk format unchanged (same `store.ts` codec + layout) — zero
  migration.
- Public API of `Store` and `store-hub` unchanged — no call-site edits in
  modules/renderer beyond the internal rewrites listed above.
- Electron IPC is structured-clone, so bigint/Date/TypedArray survive like
  the old `Channel` transport.

## AS-BUILT deltas

- `store-hub` proxy falls back to a LOCAL authority over the fs primitives
  when `process.parentPort` is absent — this path is hit only in unit tests
  (real store-writing processes — orchestrator instances + probe — always
  have a parentPort); it keeps `registry`/`tracking` tests that read config
  working without a fake main, and never runs in production.
- `store:req`/`store:res` carry the resulting value back for write/update/
  clear so the proxy caches + notifies EXACTLY what main persisted (no local
  re-merge drift).
- `StoreMain` self-manages renderer cleanup via `webContents.once("destroyed")`
  — no window-close plumbing added to main's window manager.
