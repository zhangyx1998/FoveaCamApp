# Sessions, contracts, and resource scopes

> Source of truth: `app/lib/orchestrator/protocol.ts` (contracts + Channel),
> `app/orchestrator/runtime.ts` (ServerSession + Hub),
> `app/orchestrator/resource-session.ts` (ResourceScope),
> `app/orchestrator/store-hub.ts` + `app/lib/store.ts`,
> `app/lib/orchestrator/client.ts` (renderer client).

## 1. The model

Every feature is an **orchestrator session** speaking a typed **contract**:

- **Contract** (`defineContract` in a module's `contract.ts`): declares
  `state` (client-writable key/values, echoed to peers), `telemetry`
  (server-published), `frames` (named frame topics), and `commands`
  (request/response). Contracts are renderer- and orchestrator-safe,
  Vue-free — they ARE the wire schema; the HMR boundary treats them as
  protocol (`processes.md` §5).
- **ServerSession** (orchestrator): owns the implementation. Sessions
  register with the **Hub**, which attaches every incoming client channel to
  every session and routes per-session subscribe/unsubscribe.
- **Renderer client** (`useSession(contract, name)` in
  `lib/orchestrator/client.ts`): reactive state/telemetry mirrors, `call()`
  for commands, `frame()` refs for frame topics.

Notable channel semantics:

- **Frame topics** gate on declared interest and coalesce under backpressure
  (latest-wins); a cached last payload replays to a late subscriber (V4) so
  one-shot topics (capture results) are not lost by open-after-publish.
- **State writes** echo to every *other* window, never the originator —
  a rapid local write sequence must not be clobbered by its own stale echo.
- **Passive subscription** (`{ passive: true }`): observe telemetry/state
  without activating the session (V12 — opening the profiler must not start
  actuation loops or camera taps). Activation is subscriber-refcounted:
  first active subscriber acquires resources, last one leaving drains.

## 2. Resource scopes (`defineResourceSession`)

Sessions with hardware own their lifecycle through a **ResourceScope**:

- `scope.use(acquire, release)` — acquire a resource; releases run LAST,
  after every deferred cleanup (leases outlive the loops using them).
- `scope.defer(cleanup)` — LIFO cleanup drain, async-aware.
- `scope.cancelled` + generation tokens — a stale activation (user switched
  away mid-acquire) can never mutate the next one's state.
- `idle()` returns a drain promise; `drained()` awaits every in-flight
  release, including ordered async teardown (stop capture → flush recording →
  release leases). This is what the window-switch drain (`processes.md` §3)
  and V1 rest on: **"closed" means session-idle-drained, not
  window-destroyed.**

Camera access goes through the **registry** (`orchestrator/registry.ts`):
per-serial refcounted leases; the registry advertises each leased camera's
pipes (`stream-graph.md`) and keeps ownership inside the orchestrator process.

## 3. The store

Persisted config is orchestrator-owned (`store-hub.ts`): the renderer's
`lib/store.ts` proxies reads/writes over the channel, the orchestrator owns
the file. One writer, many mirrors — the same echo discipline as session
state. Scratch namespaces let a wizard (e.g. calibrate-extrinsic) persist
mid-flow state across a dev restart.

## 4. Diagnostics

`orchestrator/diagnostics.ts`: `report()` broadcasts errors to every window
regardless of subscription (failures with no owning session, e.g. registry
errors); `span()` records boot/step timings surfaced in the profiler. The
session-status channel seeds the current error to a window that joins an
already-failed session.
