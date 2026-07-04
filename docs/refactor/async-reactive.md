# Async Reactive Store Proxy Plan

> **Status:** Sub-plan for the orchestrator refactor
> **Parent:** `docs/refactor/orchestrator.md`
> **Scope:** Make the orchestrator the sole owner of persisted store state while
> keeping renderer-side Vue state simple, synchronous, and responsive.
> **(coder, 2026-07-03):** a scoped-down version of this plan landed as
> roadmap item 4 in `orchestrator.md` §7 — `orchestrator/store-hub.ts` +
> a rewritten `app/lib/store.ts`. It keeps this doc's core runtime semantics
> (optimistic local write, authoritative echo, per-path subscription) but
> skips revisions/conflict-merge (plain last-write-wins + originating-channel
> echo-skip instead), `Store.use`/`Store.field`/debounce/`Store.meta()` — see
> `orchestrator.md` §7 item 4 for the exact delta and reasoning. This doc's
> content below is the original, fuller design; treat sections describing
> unimplemented pieces (revisions, `Store.use`, debounce, `meta.*`) as
> still-open ideas, not as built.

## Problem

The refactor target is clear: control/config state should be authoritative in
the orchestrator, while renderers become thin clients. The difficult part is the
Vue ergonomics. Existing renderer modules expect plain reactive objects:

```ts
const config = await Store.open<CameraConfig>(["cameras", key]);
config.exposure = 12000;
config.role = "L";
```

That API is productive because reads/writes are synchronous from Vue's point of
view. A direct async getter/setter model would make templates, computed values,
and form controls awkward and slow. The new store proxy must preserve the simple
surface while moving all durable ownership and conflict resolution to the
orchestrator.

## Current State

- `app/orchestrator/store.ts` reads/writes the on-disk JSON store with atomic
  writes, per-path serialization, and `update()` for read-merge-write safety.
- `app/lib/store.ts` still exists in the renderer. Unmigrated modules and
  `camera.ts` still use it directly, so store ownership is currently split.
- `useSession().state()` is already a useful prototype: the renderer gets a
  synchronous writable `customRef`; writes are sent asynchronously to the
  orchestrator; authoritative echoes update the local value.
- A previous `setState` bug showed the sharp edge: state writes were emitted as
  events but the server listened as requests. Any future store proxy must make
  message shapes explicit and test request/event/subscription pairing.
- Known `useSession` limitations matter more for store state than for transient
  UI state: a client can miss the initial state snapshot, and subscriptions can
  leak if a component unmounts before `connect()` resolves.

## Goals

- Renderer API stays intuitive: modules work with normal reactive objects/refs.
- Interactive controls stay responsive: local writes update Vue immediately.
- Orchestrator remains authoritative: persisted state, validation, clamping,
  conflict resolution, and broadcasts happen in one process.
- Desync is bounded and self-healing: stale echoes are ignored; rejected writes
  reconcile to the authoritative snapshot.
- The API supports both object stores and scalar/list stores.
- Multiple windows receive consistent snapshots and updates.

## Non-Goals

- Do not make Vue getters asynchronous.
- Do not expose file paths or filesystem access to renderers.
- Do not deep-watch arbitrary objects and persist every mutation blindly.
- Do not require each module to hand-write RPC calls for common form controls.

## Proposed Renderer API

Preferred compatibility surface:

```ts
const config = await Store.open<CameraConfig>(["cameras", key], fallback);

config.role = "L";
config.exposure_auto = "Off";
config.exposure = 12000;

const meta = Store.meta(config);
meta.pending; // readonly Ref<number>
meta.error;   // readonly Ref<Error | null>
meta.ready;   // readonly Ref<boolean>
meta.rev;     // readonly Ref<number>
```

Composition-friendly surface for components that do not want top-level await:

```ts
const config = Store.use<CameraConfig>(["cameras", key], fallback);

config.state.exposure = 12000;
config.meta.pending;
await config.ready;
```

Field helpers for controls that need explicit writable refs:

```ts
const exposure = Store.field(config, "exposure");
const role = Store.field(config, "role");
```

High-frequency controls can be configured without changing call sites:

```ts
const config = await Store.open(path, fallback, {
  debounce: {
    exposure: 50,
    gain: 50,
    frame_rate: 50,
  },
});
```

## Runtime Semantics

1. Renderer calls `open`/`subscribe`.
2. Orchestrator registers the client's interest and returns the authoritative
   snapshot in the same response.
3. Renderer creates a local reactive proxy seeded from that snapshot.
4. A property assignment updates the local proxy immediately.
5. The proxy sends a patch command to the orchestrator with the current revision.
6. Orchestrator serializes the patch per path, validates/applies it, persists it,
   increments the revision, and broadcasts the accepted snapshot or patch.
7. Renderer applies only snapshots newer than its current revision.
8. If the orchestrator rejects, clamps, or coerces a write, the renderer updates
   to the accepted value and records metadata (`error`, `lastRejected`, etc.).

This is optimistic UI with authoritative echo. It keeps controls responsive
without pretending the renderer owns durable state.

## Protocol Shape

Use one store service/session, not ad-hoc IPC per module:

```ts
type StorePath = string[];

type StoreSnapshot<T> = {
  path: StorePath;
  rev: number;
  value: T;
};

type StorePatch<T> = {
  path: StorePath;
  baseRev: number;
  patch: Partial<T>;
};
```

Commands:

- `store:subscribe({ path, fallback }) -> StoreSnapshot<T>`
- `store:patch({ path, baseRev, patch }) -> StoreSnapshot<T>`
- `store:write({ path, baseRev, value }) -> StoreSnapshot<T>`
- `store:clear({ path }) -> StoreSnapshot<T>`
- `store:list({ path }) -> string[]`
- `store:unsubscribe({ path }) -> void`

Events:

- `store:update:${pathKey}` -> `StoreSnapshot<T>`
- `store:error:${pathKey}` -> `{ rev?: number; message: string }`

The important property is atomic subscription: the renderer registers interest
and receives the current snapshot in one request. That fixes the current
initial-state race.

## Renderer Implementation Sketch

The renderer proxy should use a `Proxy` set trap, not a deep watcher:

```ts
function createRemoteObject<T extends object>(
  initial: T,
  sendPatch: (patch: Partial<T>) => void,
): T {
  const target = reactive(structuredClone(initial)) as T;

  return new Proxy(target, {
    set(obj, key, value) {
      (obj as any)[key] = value;        // immediate Vue responsiveness
      sendPatch({ [key]: value } as Partial<T>);
      return true;
    },
    deleteProperty(obj, key) {
      delete (obj as any)[key];
      sendPatch({ [key]: undefined } as Partial<T>);
      return true;
    },
  });
}
```

The implementation needs an internal "applying authoritative update" guard so
server echoes do not generate new patches:

```ts
let applying = false;

function applySnapshot(value: T, nextRev: number) {
  if (nextRev <= rev.value) return;
  applying = true;
  try {
    replaceReactive(proxyTarget, value);
    rev.value = nextRev;
  } finally {
    applying = false;
  }
}
```

For arrays and scalar values, provide a separate `remoteRef<T>` or treat the
whole value as `write(value)` rather than property patches.

## Orchestrator Implementation Notes

- Reuse `app/orchestrator/store.ts` for atomic writes and per-path serialization.
- Keep a per-path in-memory document cache:
  - current value
  - current revision
  - subscribed channels
  - pending operation chain
- Validate/clamp in session-specific command handlers when state is hardware
  backed, or in generic store hooks for pure config documents.
- Broadcast after persistence succeeds.
- On channel detach, remove that channel from all subscribed paths.
- On shutdown, flush pending operations before releasing resources.

## Conflict Handling

Basic policy:

- If `baseRev === currentRev`, apply patch.
- If `baseRev < currentRev`, merge patch onto current value when fields do not
  conflict, or reject/overwrite according to per-document policy.
- Always return the latest authoritative snapshot.
- Renderer ignores stale snapshots by revision.

For sliders and other fast controls, allow debounced patch sending but keep the
local optimistic value instant. If a newer local edit is pending, an older echo
should update `rev` but should not visibly roll the control backward unless the
authoritative value differs after the latest accepted write.

## Migration Plan

1. Add orchestrator store service with atomic `subscribe -> snapshot`.
2. Add renderer `Store.open` compatibility wrapper backed by the service.
3. Port one low-risk config consumer from renderer `Store` to remote `Store`.
4. Move camera config reads/writes to remote `Store`; keep calibration loaders
   on old renderer `Store` until their modules migrate.
5. Add list/clear support and migrate calibration/data-management consumers.
6. Remove direct renderer filesystem store writes except renderer-only UI state.
7. Retire or rename the old renderer `Store` to make ownership obvious.

## Open Decisions

- Should `Store.open()` be optimistic by default for all documents, or should
  some stores require pessimistic writes?
- Should validation live in the generic store service, per-session hooks, or
  domain sessions only?
- Should deletes be represented as `undefined`, JSON Patch, or explicit
  `{ op: "delete", key }` patches?
- How much of `Store.meta()` should be public API versus debugging-only?

