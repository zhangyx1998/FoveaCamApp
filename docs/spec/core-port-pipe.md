# core native PORT / PIPE substrate

Behavior spec for `core/include/PortPipe.h` + `core/src/PortPipe.cpp`. Design
ruling: `docs/proposals/native-port-pipe.md` (2026-07-10). This file records the
runtime contract; the code carries `// spec:` pointers to the anchors below.

## model {#model}

Bricks expose named TYPED ports as JS handles (`<name>_out` / `<name>_in`
accessor properties → cached `Port` CoreObjects). `outPort.pipe(inPort, opts?)`
connects them THREAD-TO-THREAD natively and returns a `Link` CoreObject with
`probe()` + `release()`. The async-iterator pattern is eliminated wherever BOTH
endpoints are native C++ threads (ruling 1); the iterator remains only where JS
is a genuine consumer.

## link-types {#link-types}

`opts.type`, default `"latest"`:

- **latest** — latest-wins, slow consumer sheds stale items (`Threading::Leaky`).
- **fifo** — lossless bounded blocking queue, producer BACKPRESSURE + high-water
  metering (`Threading::FIFO`; `opts.depth`).
- **ring** — bounded drop-OLDEST, non-blocking producer (`Threading::Ring` — the
  StereoStream PairRecord ring generalized; `opts.size`).

## type-erasure {#type-erasure}

Payloads are all `Shared<T>::Ptr`-shaped. The erased surface is deliberately
small — a tag string + a `std::type_index` + one type-erased sink / connect
factory per instantiated payload type (the typed knowledge lives in
`makeOutPort<P>` / `makeInPort<P>`, where the brick knows P). Tag equality AND
payload-type equality are checked at `pipe()` time (JS `TypeError` on a mismatch)
— never in the hot loop. `Stream<T>` itself is NOT refactored: the link
subscribes with a plain `Subscriber<P>` (multiple subscribers are native to the
stream), so teardown rides the existing eject/drain discipline
(`closes_in_flight_`; see `docs/spec/core-streams.md`).

## delivery {#delivery}

producer thread → channel → the link's OWN delivery thread → consumer sink. The
extra thread keeps consumer bricks' loop structures untouched (a paced brick like
the IMM predictor cannot block on a channel) and gives every link type one
uniform shape. Probe counters are plain atomics probed out-of-loop (the
never-gate rule).

## teardown {#teardown}

`release()` (idempotent; the destructor calls it) retires the topology edge
FIRST (probe-safe), then closes the channel BEFORE unsubscribing. Closing first
wakes a backpressure-blocked producer push (FIFO) and the delivery read, so
neither can deadlock the unsubscribe/join (the ChainedStream close-first
discipline).

`closeChannel()` is shared by `release()` and EVERY `deliver()` exit path (EOS,
throwing sink, ring drain). If the delivery thread dies with the channel open, a
FIFO link keeps backpressure-blocking the producer's fan-out INSIDE the stream
mutex (whole-pipeline freeze + shutdown deadlock) and latest/ring become silent
black holes with pinned payloads. Closed, the producer's next push sees EOS → the
Stream fan-out ejects this subscriber.

## leaky-retention {#leaky-retention}

Latest links use `take` (move-out) semantics and reset the local after delivery,
so neither the channel nor the delivery thread pins the last payload while
blocked on a stalled upstream (Leaky retention fix, 2026-07-11). `LinkStats.held`
reports whether the slot currently pins a payload — true only between a write and
its readout; a drained link on a stalled upstream reads false. That regression
surface is what the `held` probe guards.

## topology {#topology}

Each live link self-registers; `appendLinkReports` emits an EDGES-ONLY
`NodeReport` row (kind `""`, `edgesOnly: true`) carrying the one `from → to`
input. The JS fold unions it into the consumer's node, so native-piped edges show
on the profiler graph (with fifo hwm / lossy flags) WITHOUT any session-side
`registerGraphWiring` shim.
