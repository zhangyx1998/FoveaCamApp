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
camera/<serial>/raw                 UNPACKED 16-bit container tap (recorder src)
camera/<serial>/raw12p              PACKED verbatim wire payload tap, dtype U8
                                    (recorder src; refcounted raw-pipe registry)
<sourceId>/zlib                     per-frame zlib compression sibling
                                    (the compress brick; `pixelFormat` gains
                                    `/zlib`)
camera/<serial>/convert             BGRA8 converted pipe
camera/<serial>/undistort           undistorted pipe (native remap)
camera/<serial>/undistort/fovea/<n> dynamic fovea crop pipe (crop of undistort)
camera/<serial>/undistort/slice/<name>  SESSION-owned named crop (same brick as
                                    fovea, outside the composed slot space)
<sourceId>/scale/<name>             reactive resize pipe (ScaleStream brick;
                                    nests under its source — that IS its input)
stereo/<name>                       two-input SGBM join (StereoStream brick;
                                    F32 disparity out — a root: a cross-camera
                                    join belongs to neither camera; its
                                    left/right edges carry the wiring)
stereo/composite                    two-input composite join (CompositeStream
                                    brick; BGRA8 anaglyph|difference — same
                                    root rule as stereo/<name>)
<sourceId>/heatmap/<name>           colormap pipe (HeatmapStream brick; F32/U8
                                    1-channel → BGRA8; nests under its source)
camera/<serial>/kcf                 native KCF track stream (raw source)
camera/<serial>/kcf-multi           native multi-target KCF track stream
camera/<serial>/undistort/kcf       chained KCF on the undistort brick (§3.5)
camera/<serial>/detect              native marker detector stream
pair/<stage>                        L/R exposure-pair join (PairStream; a root,
                                    like stereo — <stage>-L/<stage>-R + a
                                    controller `anchor` edge; root|exact modes)
controller/anchors                  FIN enrichment node (volts→V2A angle→H,
                                    stage-independent anchors fanned to pairs)
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
never per-frame allocation.

## 3. Bricks

| Brick | Impl | Output |
|---|---|---|
| camera source | Arv stream thread (`core`) | raw frames (native) |
| converter | `ConverterStream` — one thread per (camera × format) | `camera/<serial>/convert` pipe |
| undistort | `UndistortStream` — remap maps built natively at attach from the persisted calibration | `camera/<serial>/undistort` pipe |
| fovea crop | `FoveaStream` — a ChainedStream taking a plain ROI crop of its upstream brick's frames (the undistort brick, or convert for raw crops); undistortion happens ONCE upstream and N foveas share it | `camera/<serial>/undistort/fovea/<n>` pipe |
| scale | `ScaleStream` — ChainedStream `cv::resize` with reactive params (`ratio`/`dwidth`/`dheight`/`dsize`); out dims recomputed per frame from the active input dims; origin forwarded unscaled | `<sourceId>/scale/<name>` pipe |
| stereo (SGBM) | `StereoStream` — the first TWO-input chained brick: SGBM over a left/right tap pair (latest-wins; ticks on left arrivals), F32 disparity out in left-frame coords; parked unless demanded (the on-demand SGBM view) | `stereo/<name>` pipe (F32) |
| heatmap | `HeatmapStream` — ChainedStream colormap (TURBO) of a 1-channel F32/U8 source to BGRA8; reactive `{min,max}` (absent = per-frame auto-normalize) | `<sourceId>/heatmap/<name>` pipe |
| composite | `CompositeStream` — two-input BGRA8 color join (StereoStream skeleton, no SGBM): reactive `{mode: anaglyph\|difference}`; anaglyph = LEFT's R + RIGHT's G/B (red = left eye), difference = per-channel `absdiff`; left-paced, latest-wins right; alpha 255 | `stereo/<name>` pipe (BGRA8) |
| pair | `PairStream` — per-stage L/R join on its own thread; two in-process FIFO `TapChannel` inputs (`OwnedFrame::Ptr` — pins references, no pixel copy); anchors pushed via NAPI at FIN rate; `root` tolerance-matches raw arrivals to the FIN, `exact` joins on carried deviceTimestamps; batched record iterator + meter; always-running with the trigger topology | pair records (async generator + meter) |
| compress | `CompressRunner`/`CompressBinding` (`CompressStream.cpp` — no class named `CompressStream`) — taps any frame brick (`OwnedFrame` FIFO), republishes each frame as an INDEPENDENT zlib blob (seekable) into a `/zlib` sibling pipe; ring-v5 `payloadBytes` carries the variable length. Driven by the app-level `record_compression` setting: under `"zlib"` the generic recording facility (`raw-recording`) routes ALL its raw streams here; multi-fovea keeps per-stream toggles that gate WHICH streams use it | `<sourceId>/zlib` pipe |
| KCF tracker | native thread, latest-frame-wins; a CHAINED variant (`camera/<serial>/undistort/kcf`, controller-node §3.5) tracks the undistorted view on its own thread | track results (async generator + meter) |
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
- **One-shot:** the composable capture facility (`capture-helper.ts` →
  `capture-node.ts`'s capture worker) reads a held pipe's latest SHM slot
  on demand — pinned to the latest seq at read time, so a steer-then-capture
  pass can never grab a pre-steer frame; a read timeout fails the pass loudly.
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

The command surface (`pipe-contract.ts`): `compose({id, kind, inputs,
params?}) → NodeAdvert` and `decompose(id)`, with two id-rooted modes
(`pipe-session.ts`):

- **`win/<windowId>/...`** — validated against the CALLER's channel identity
  (spoof-proof: composing outside your own `win/` namespace is rejected);
  owned by that window; decompose/window-close tears it down.
- **`camera/...`** — REFCOUNT semantics: compose = ensure-materialized + ref
  (N windows share one brick), decompose = unref, refs→0 = teardown through
  the kind's registered `NodeMaterializer`. Kinds without a materializer
  (convert/undistort, already advertised by the session) are ref-only.

Materializers (`PipeSessionDeps.materializers`, one per brick kind) own
create/teardown of the native resources; every (re)materialization bumps the
node's epoch so consumers reconnect. The broker, materializers, and window
hooks are injected — vitest drives the whole surface core-free.

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
