# Native port pipe — JS-orchestrated thread-to-thread links

Status: **SHIPPED (2026-07-10; rig pass owed — see AS SHIPPED below).**

## AS SHIPPED (2026-07-10)

Landed as ruled: `core/include/PortPipe.h` + `core/src/PortPipe.cpp` (erased
Port/Link machinery + CoreObjects + root `core.Port` namespace),
`core/lib/Threading/Ring.h` (reusable drop-oldest channel — StereoStream's
PairRecord ring now uses it), phantom-branded `OutPort<T>`/`InPort<T>` +
discriminated `LinkOptions` in the hand-written d.ts, and the compile-time
harness `app/test/port-pipe.types.ts` (8 `@ts-expect-error` cases compiled
by the vue-tsc gate). Proving case live: disparity-scope pipes
`tk.track_out.pipe(imm.measure_in)` (latest) and the JS measurement relay is
deleted — kcf→imm no longer crosses the JS boundary; the session keeps its
own kcf iterator (JS is a genuine consumer for pid target/telemetry).

Deltas from the ruled sketch:
- `InPort.__payload` is REQUIRED (optional brand let `OutPort` structurally
  satisfy `InPort`, defeating the out→out compile guard).
- Topology edge = an "edges-only" NodeReport row unioned into the owning
  node by the fold (a full row would clobber the session's node kind/owner
  registration); fifo links carry `queue {highWater, capacity}` on the edge.
- Delivery runs on a per-link `port-link` thread (uniform semantics across
  latest/fifo/ring; a producer-thread sink can't express fifo backpressure).
- Link disconnect = the repo-standard idempotent CoreObject `release()`.
- Test 43 gained a settle discipline (pre-existing test race exposed by the
  rerun: independent synthetic sources can pair across a plane switch).

Known residuals: a live link pins BOTH endpoint streams (release order is
the session disposer's job; a leaked link is visible as a persistent
profiler edge). Pre-existing on the Linux box, unrelated: `core/test/12`
KCF-on-OpenCV-4.6 sensitivity; failed-assert exits in numbered tests
segfault at env teardown (cosmetic).

RIG-GATED (bench session): kcf→imm edge renders from the link's Topology row
with truthful rates; wave-1 behavior byte-identical; repeated window
open/close under live tracking (link release under producer load); Mac
`make build` + tests 44/42.

## User rulings (2026-07-10)

1. **The async-iterator pattern is eliminated wherever BOTH endpoints are
   native C++ threads.** The iterator remains legitimate only where JS is a
   consumer.
2. **Interface shape**: `node1.mea_out.pipe(node2.mea_in)` — bricks expose
   named, typed ports as JS handles; `pipe()` connects them natively.
3. **`pipe()` returns a pipe/link object probeable and manageable from JS.**
4. **`pipe()` takes an optional link-type arg with per-type parameters**:
   `fifo` (depth), `ring` (size), `latest`.

## Design

### Ports

Each brick exposes its ports as properties on the NAPI wrapper (accessor →
lazily-created, cached `Port` CoreObject): an out-port wraps the brick's
`Stream<T>` + a runtime stream tag; an in-port wraps a native sink + tag.
Naming: `<name>_out` / `<name>_in` properties (per the ruled sketch), also
enumerable for tooling. Hand-written d.ts declares them.

### pipe()

`outPort.pipe(inPort, opts?)` — native connect:

- **Type check at connect time**: tag equality (e.g. `"track"`,
  `"imm-measurement"`) or `JS::TypeError` — never a hot-loop check.
- **Link types** (`opts.type`, default `latest`):
  - `latest` — latest-wins, slow consumer sheds stale items
    (`Threading::Leaky`, the LeakyTapChannel policy).
  - `fifo` — lossless bounded blocking queue with producer backpressure +
    high-water metering (`Threading::FIFO`, the FifoTapChannel policy);
    `opts.depth`.
  - `ring` — bounded, drop-OLDEST overwrite, non-blocking producer (the
    StereoStream PairRecord-ring policy generalized into a reusable
    `RingTapChannel`); `opts.size`.
- Parameter validation NAPI-side with named `invalid_argument`s (the
  stereo-params precedent).
- Connecting subscribes (un-parks the producer per the consumer gate);
  releasing unsubscribes (parks when last consumer leaves).

### TS harness — compile-time endpoint compatibility (ruling addendum, 2026-07-10)

The runtime tag check is the last line of defense, not the first: the
hand-written d.ts types the ports GENERICALLY with a phantom payload brand
(the `cmd<Arg, Ret>()` precedent from the contract system), so an
incompatible `pipe()` fails `vue-tsc`, not the rig:

```ts
interface OutPort<T> { pipe(target: InPort<T>, opts?: LinkOptions): Link; }
interface InPort<T>  { readonly __payload?: T; }   // phantom brand only
// tracker.track_out: OutPort<TrackResult>; imm.measure_in: InPort<TrackResult>
```

`LinkOptions` is a discriminated union so per-type params can't cross:
`{ type: "fifo"; depth?: number } | { type: "ring"; size?: number } |
{ type: "latest" }`. A type-level test file (compiled by the vue-tsc gate)
pins the harness with `@ts-expect-error` cases: payload mismatch, wrong
per-type param (e.g. `{ type: "latest", depth: 8 }`), piping out→out or
in→in. Runtime tags and phantom types must agree — the conformance test
asserts the tag strings the d.ts documents.

### The Link object (returned to JS)

CoreObject with:
- `probe()` → `{ type, capacity, written, delivered, dropped, highWater,
  open }` — counters maintained on the producer/consumer threads with the
  same never-gate discipline as ThreadMeter.
- `release()` — idempotent disconnect (also detaches the topology edge).
  Resizing/retyping is NOT supported — release and re-pipe (keeps the
  channel immutable while hot).
- Registers its edge in `Topology.report()` at connect and retires it at
  release, so native-piped edges appear on the profiler graph with
  hwm/drop stats WITHOUT any session-side `registerGraphWiring` shim (FIFO
  edges keep the hwm treatment from controller-node-and-fifo-edges).

### Proving case (this wave)

`kcf.track_out.pipe(imm.measure_in)` in disparity-scope: the imm brick gains
a native measurement in-port (the NAPI `ingest` stays for tests/conformance);
the session stops relaying measurements (`imm.ingest(r)` in the consume loop
is deleted) but KEEPS its own kcf iterator consumption (JS is a genuine
consumer for pid target + telemetry — multiple subscribers are native to
`Stream<T>`). The `imm → compose` iterator REMAINS: compose is a JS node
(ruling 1's "both endpoints native" does not hold there).

## Explicitly out of scope (pending a separate ruling)

Native compose + a native controller position in-port (which would eliminate
the 600 Hz `imm → compose` iterator) — it moves ruled JS responsibilities
(`predictVolts`, `mirrorHistory` provenance) across the boundary and touches
recorder/footprint consumers. Phase-2 proposal if ruled.

## Verification (software)

- New numbered core test (`44-port-pipe`): synthetic source→sink across all
  three link types — delivery order, fifo blocking + high-water, ring
  drop-oldest accounting, latest-wins shedding, probe counters, type-tag
  mismatch throw, idempotent release, connect/release under producer load
  (teardown race), topology edge appear/retire.
- `42-imm-predictor` extended or kept green: piped-measurement path matches
  the NAPI-ingest path (same conformance vectors through the port).
- vitest: session wiring through fake seams; vue-tsc; boundary greps.
- RIG-GATED: profiler shows the native `kcf → imm` edge with truthful rates
  from the link probe instead of the JS shim.
