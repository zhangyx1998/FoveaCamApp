# The typed stream node graph

> Source of truth: `app/lib/orchestrator/graph-contract.ts` (types + `nodeId`),
> `app/orchestrator/graph-topology.ts` (served snapshot),
> `app/lib/orchestrator/pipe-contract.ts` + `pipe-consumer.ts` + `shm-client.ts`
> (consumption), `app/orchestrator/pipe-session.ts` (broker + compose),
> `core` Pipe / ConverterStream / UndistortStream / Tracker,
> `app/orchestrator/vision-worker*.ts`.

## 1. Model

Every producing endpoint is a **node** with a unique **path-like id = its
output stream id**. `nodeId` (graph-contract) is the single spelling
authority — never inline the strings:

```
camera/<serial>                     raw source (native Arv stream)
camera/<serial>/convert             BGRA8 converted pipe
camera/<serial>/undistort           undistorted pipe (native remap)
camera/<serial>/undistort/fovea/<n> dynamic fovea crop pipe
camera/<serial>/kcf                 native KCF track stream
win/<windowId>/...                  window-composed nodes (kernels, …)
```

A node has **multiple named input ports but exactly one output**, typed by
the `StreamType` harness (`frame` with pixelFormat+dtype · `track` · `detect`
· `analysis` with a named schema). Shared resource bricks live under
`camera/`; window-composed nodes live under `win/<windowId>/` and tear down
with their window (`processes.md` §3). A format access modifier
(`@<PixelFormat>`) appears in the last segment only when a second
simultaneous format of the same stream exists.

**Edge rule:** wiring lives only on edges (producer → named input port).
The graph renders the PHYSICAL edge — e.g. a fovea node's id nests under
`/undistort/` (it crops undistorted space) but its physical input is the raw
camera stream (the native producer fuses map-ROI + remap in one pass), so the
edge is camera→fovea.

## 2. Transports

| Transport | What | Where |
|---|---|---|
| `native` | C++ thread → C++ thread, in-process | capture sink → converter |
| `pipe` | SHM seqlock ring, readable cross-process | converter/undistort/fovea outputs |
| `port` | worker_thread MessagePort | vision kernel results |
| `channel` | orchestrator↔renderer session channel | frame topics, telemetry |
| `sink` | consumes only | renderer views, recorder |

**SHM pipes** are the frame backbone: a C++ publisher thread owns the
seqlock/memcpy off the JS loop; `PipeSpec` declares format/dtype/dims/
`bytesPerFrame` up front (no shape inference). Correctness invariants: the
seqlock uses both acquire/release fences (V8 — a torn frame can validate
cleanly on ARM64 without them) and slot metadata is copied inside the
validated window (V9). Dynamic pipes (fovea) allocate a **max-footprint
ring**; each frame carries its own active w/h (+ crop origin), and every
re-advertise of an id bumps its **epoch** so consumers detect reuse and
reconnect. Consumers **reuse pre-allocated buffers** from a transfer pool —
never per-frame allocation (the historical manage-cameras freeze was exactly
that GC storm).

## 3. Bricks

| Brick | Impl | Output |
|---|---|---|
| camera source | Arv stream thread (`core`) | raw frames (native) |
| converter | `ConverterStream` — one thread per (camera × format) | `camera/<serial>/convert` pipe |
| undistort | `UndistortStream` — remap maps built natively at attach from the persisted calibration | `camera/<serial>/undistort` pipe |
| fovea crop | dynamic crop+resize from the raw stream (fused with undistort maps) | `camera/<serial>/undistort/fovea/<n>` pipe |
| KCF tracker | native thread, latest-frame-wins | track results (async generator + meter) |
| marker detector | `detector.stream` (native) | detection sets |
| vision kernels | per-session `worker_thread` (`vision-worker.ts`), dispatched by kind | results + derived frames over MessagePort |

Producers are **consumer-gated**: a pipe with zero connected consumers parks
its producer thread (refcount on the broker's connect/disconnect); production
resumes on the next connect. Camera exclusivity, lease refcounts, and the
gate all live in the orchestrator broker — workers and renderers only ever
receive segment names.

## 4. Consumption

- **Renderer:** `usePipeFrame(pipeId)` (client.ts) — discovers the advert in
  the `pipes` session state, `connectPipe`s once for a handle, then reads
  frames via the preload's SHM reader addon into pooled buffers; reconnects
  on epoch bumps, clears on close. The advertised set is a keyed Record —
  pipes appear/disappear at runtime and views react by diffing it.
- **One-shot:** `readNextPipeFrame` (pinned to latest seq at call time, so a
  steer-then-capture pass can never grab a pre-steer frame; throws on
  timeout so the pass fails loudly).
- **Workers:** vision workers SHM-read pipes directly (reader addon path
  passed by the host) — read-only; the broker/gate stays orchestrator-side.

## 5. Composition

The renderer **composes** its window's graph at runtime: the `pipes` session
exposes `compose`/`decompose` commands that validate a `NodeSpec` request
(typed inputs against each brick's declared I/O), materialize the brick, and
wire it under `win/<windowId>/...` (the channel's windowId — spoof-proof,
`processes.md` §3). Window close auto-tears the namespace via
`hub.onWindowClosed`. Multi-fovea is the flagship: per-target fovea nodes +
KCF spawn/cancel mid-flight as targets come and go.

*(Planner-review stub: the compose request/validation surface is C-owned —
expand this section from `pipe-session.ts` once its API is final.)*

## 6. Observability

`graphTopology()` (orchestrator, `graph-topology.ts`) folds the live node
set + edges + per-node meter badges into `PerfSnapshot.graph` on the same
1 Hz profiler poll — exact `bytesPerSec` from bytesTotal deltas per
(id, epoch), aggregate consumer sinks (`<pipeId>/consumers`), and session
wirings. Meters are keyed by node id where pipe-backed (`metering.md`). The
profiler's graph panel renders it with layout keyed on (id, epoch) membership
— stats refreshes never move nodes; composition churn re-layouts
(`app/src/profiler/GraphPanel.vue`). A renderer-side derivation
(`graph-view.ts deriveTopology`) remains as fallback for an orchestrator
without the builder injected.
