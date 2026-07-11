# Config store — behavior spec

Behavioral contracts for the config store: the main-process authority, the proxy
clients, codec, and migrations. Source pointers are per section; the code carries only
load-bearing invariants inline.

## Orchestrator store client (store-hub) {#store-hub}

Source: `app/orchestrator/store-hub.ts`
(`docs/proposals/config-store-main-authority.md`)

The single authority lives in MAIN; this module is a thin proxy over the instance's
`parentPort` that preserves the exact public API every orchestrator-internal caller
relied on (`read`/`write`/`update`/`clear`/`list`/`subscribe`/`writeCounts`) and their
reactive semantics: a `subscribe()` listener fires on ANY window's edit, now including a
window on a DIFFERENT orchestrator instance (the old per-process hub could not see across
instances — defect D1). `write`/`update`/`clear` forward to main and locally apply the
value main returns, so this process's own subscribers (anaglyph-style retune, etc.)
update without a double-echo (main skips the originator).

`attachStore` is gone: renderer `Store` clients now talk to main directly (ipcRenderer),
not through the orchestrator channel.

Transport: this process shares its one `parentPort` with `index.ts`'s control-message
handler; the proxy adds its own `message` listener and filters for
`store:res`/`store:changed` only. When NO `parentPort` exists (unit tests / non-utility
contexts) it falls back to a LOCAL authority over `./store.ts`'s fs primitives —
production store-writing processes always have a `parentPort`, so that fallback never runs
at runtime.

## Store-schema migration framework {#store-migrations}

Source: `app/lib/store-migrations.ts`
(`docs/proposals/calibration-records-v2.md` §Migration framework)

MAIN owns the config store (692f0e3), so migrations run in MAIN at `StoreMain`
construction — BEFORE any renderer or orchestrator client is served, so no client ever
observes a half-migrated tree.

### The durable contract (read before adding a migration)

The store carries a SCHEMA VERSION in the reserved doc `["schema"]`
(`store/schema.json` → `{ version }`). An unversioned/legacy tree = version 0.
`MIGRATIONS` is an ORDERED registry of `(from → to)` steps. On boot:

1. read the on-disk version;
2. if it is behind `STORE_SCHEMA_VERSION`, SNAPSHOT the store repo (a git commit; push is
   best-effort — offline must not block boot), then
3. apply each pending migration in order (each idempotent + pure over the injected fs
   surface), then
4. write the new version and SNAPSHOT the migrated result.

To evolve the schema, APPEND a migration `{ from: N, to: N+1, … }` and bump
`STORE_SCHEMA_VERSION` — never mutate a shipped migration (a user's tree may already have
run it). Each migration MUST be safe to re-run: the framework won't re-run a step once the
version advances, but tests assert run-twice is a no-op regardless, so write the step to
converge (check-before-write / derive ids from content).

The git snapshot boundary is INJECTED (`SnapshotHook`) so this module stays pure +
unit-testable — the real git shell lives in main (store-main.ts) and is exercised only in
production; the decision logic (when to snapshot, ordered application, idempotency) is what
the tests cover.

## Renderer store client {#store-client}

Source: `app/lib/store.ts`
(`docs/proposals/config-store-main-authority.md`)

Renderer-side config store client. Same public shape as before (`open`/`clear`/`list`/
`read`) so every existing consumer keeps working, but the transport now targets MAIN (the
single config authority) over `window.foveaBridge` (ipcRenderer), NOT the orchestrator
channel. Two consequences that fix real data-loss classes:

- The connection never dies with an orchestrator instance (ipcRenderer is always up), so a
  Settings/TeleCanvas window that outlives its instance keeps persisting — the old one-shot
  `connect()` decay is gone by construction.
- A local edit sends a key-level PATCH (a diff of the tracked doc against the last value
  main acked), not a whole-document write, so two windows editing DIFFERENT keys inside one
  round-trip both survive instead of clobbering.

`open()` still returns a plain Vue-reactive object a module mutates directly; a deep
mutation queues a patch on the next microtask (same debounce as before). A change from
another window (or an orchestrator-internal session) arrives as `store:changed` and is
applied onto the SAME object reference via the `applying` guard, so templates/computed
update for free. Values cross via ipcRenderer's structured clone (bigint/Date/TypedArray
survive) — no codec needed here.

## Config schema (shared constants) {#config-schema}

Source: `app/lib/config-schema.ts`

SINGLE SOURCE OF TRUTH for the shared `["config"]` document's cross-process schema — the doc
path, value unions, defaults, and clamp bounds that BOTH the renderer (`@lib/config`,
Vue-bound) and the orchestrator readers (`@orchestrator/{prediction-rate,serial-latency,
record-compression,anaglyph-style}`, which must stay Vue-free) need to agree on. It exists
because `@lib/config` imports Vue, so a session-reachable reader cannot pull it in without
bundling Vue into the utility process. Before this module the readers HAND-MIRRORED the
path/union/default/clamp with "keep in sync" comments. Vue-free AND Node-free (types + plain
data, zero imports); follows the `docs/schema/anaglyph.ts` precedent.

## Store authority core {#store-authority}

Source: `app/lib/store-authority.ts`
(`docs/proposals/config-store-main-authority.md`)

The single config-store authority core: the old `orchestrator/store-hub` cache/serialize/
notify engine, lifted out and made transport-free — a per-path in-memory cache, a
per-document serialized op queue (so a broadcast never reflects an uncommitted value and
concurrent writes never tear), and notify-except-origin (an originator is never echoed its
own change). The fs backend is INJECTED (`StoreFsBackend`) so it's unit-testable with an
in-memory map, and so the one real instance can live in MAIN over `orchestrator/store.ts`'s
fs primitives (same on-disk codec, zero migration). `patch` is the key-level merge the
renderer client drives; `write`/`update`/`clear` keep the exact orchestrator-internal
semantics. Every mutating op returns the RESULTING document value so a proxy can cache +
notify exactly what was persisted.

## Store proxy (client) {#store-proxy}

Source: `app/lib/store-proxy.ts` (`docs/proposals/config-store-main-authority.md`)

Client-side proxy over the MAIN config-store authority, used by the orchestrator + probe
processes via their `parentPort`. Exposes the exact `store-hub` internal API
(read/write/update/clear/list/subscribe) but every op is a `store:req` to main, correlated
by id to a `store:res`; main pushes `store:changed` for every subscribed path so this
process's live `subscribe()` listeners fire on ANY window's edit — regardless of which
orchestrator instance that window is on. Transport-agnostic + Electron-free (unit-tests
against a fake link). A mutating op caches + notifies the VALUE main returns (not a local
re-merge), and main skips echoing a change to its originator, so this process's own write
both persists and updates its local subscribers with no double-fire.

## Store fs primitives {#store-fs}

Source: `app/orchestrator/store.ts`

Internal filesystem primitives for `store-hub.ts`. Do NOT import from sessions or helpers;
route reads/writes through store-hub so the in-memory cache, write counts, and renderer
notifications stay authoritative. Reads/writes the same on-disk JSON files as the renderer
`Store` (same path layout + codec) but without Vue reactivity or `ipcRenderer`; the userData
path comes from `FOVEA_DATA_PATH`. Writes are atomic (temp file + rename) and operations on
the same file are serialized, so rapid edits (e.g. dragging the exposure slider) can never
tear a concurrent read or lose a read-modify-write.

## Patch protocol helpers {#store-patch}

Source: `app/lib/store-patch.ts` (`docs/proposals/config-store-main-authority.md`)

Pure diff/merge helpers for the config-store patch protocol. The renderer `Store` client
diffs its tracked reactive document against the last value it knows main has (`diffKeys`) and
sends the resulting top-level-key ops; main merges them into the authoritative document
(`applyOps`). Both halves are transport-free and unit-tested — no Vue, no Electron, no fs.
`deepEqual` handles the value shapes that cross the structured-clone / store-codec boundary
(bigint, Date, TypedArray) so a no-op edit produces NO patch.
