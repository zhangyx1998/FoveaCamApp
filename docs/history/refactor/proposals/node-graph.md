# real-2 — Typed stream node graph (composable bricks + profiler visualization)

Planner brief — 2026-07-08. User objectives 1+2. Design-first (B/C sketch, planner
rules, then build). A starts the visualization against the topology contract.

## User directives (verbatim intent)

1. Visualize the thin-orchestrator + C++-compute-thread architecture as a **node
   graph in the profiler**, with perf stats on each node and edge. External
   visualization library PERMITTED.
2. The graph is **runtime extensible** (e.g. each multi-fovea stream can be
   spawned or cancelled mid-flight). The graph is **constructed per application
   window — the renderer demands composition/decomposition**; the orchestrator
   only provides building blocks. Each node has a **unique path-like ID (= its
   stream id)**. A **typing harness strictly models** the data type accepted /
   produced by each node. A node may have **multiple named input streams**
   (e.g. a stereo pair takes 2) but exactly **one output stream**.

## What exists (the bricks, post-real-1g)

| Brick | Where | Output |
|---|---|---|
| camera source | Arv::Stream thread | raw frames (native) |
| converter | `ConverterStream` (B-18) | `camera:<serial>` pipe, format via `spec.pixelFormat` |
| undistort | `UndistortStream` (B-23) | `undistort:<serial>` pipe (+`@<format>`) |
| KCF tracker | `KcfTrackerStream` (B-17) | TrackResult via async generator (NOT a pipe) |
| marker detector | `detector.stream` | detection points (NOT a pipe) |
| vision kernels | worker_thread (`disparity`/`display`/`distortion`/`checker`) | results + derived frames via MessagePort (NOT pipes) |
| consumers | renderer `usePipeFrame`, vision-worker PipeInputs, one-shot reads | — |

Gaps the design must close:
- **Node identity**: today's ids are `camera:<serial>` / `undistort:<serial>`;
  the directive wants PATH-LIKE ids (e.g. `camera/<serial>`,
  `camera/<serial>/undistort`). C proposes the scheme + migration (few
  consumers — cheap to rename now).
- **Non-pipe outputs**: tracker/detector/kernel outputs are not visible as graph
  streams. Decide: model them as nodes with typed non-frame output streams
  (scalar/result streams) in the topology even if transport ≠ SHM pipe.
- **Composition API**: today sessions hardcode composition. Target: the RENDERER
  composes (add/remove typed nodes at runtime per window); the orchestrator
  materializes bricks + wires them + returns node state. Sessions keep only
  control loops (actuation/serial) + resource brokering.
- **Fovea brick**: multi-fovea needs spawn/cancel-able fovea streams (crop nodes)
  — the concrete runtime-extensibility case (ties to the dynamic-pipes design,
  C-20: max-footprint rings, per-frame active w/h, epoch reuse-safe ids).
- **Topology snapshot**: a `graphTopology()` surface — nodes (id, kind,
  input/output types, meter: util/rate/maxIntervalMs/drops) + edges (producer →
  consumer named port; rate/bytes from pipe meters + consumer refcounts) — for
  the profiler graph and for the renderer's composition UI.

## Typing harness (sketch — C refines)

```ts
type StreamType =
  | { kind: "frame"; pixelFormat: PixelFormat; dtype: "U8" | "U16" }
  | { kind: "track"; }            // TrackResult
  | { kind: "detect"; }           // marker detections
  | { kind: "analysis"; shape: ... }; // vergence/disparity scalars

interface NodeSpec<I extends Record<string, StreamType>, O extends StreamType> {
  id: string;              // path-like, unique, = output stream id
  kind: string;            // brick name: camera|convert|undistort|kcf|fovea|...
  inputs: { [K in keyof I]: string /* upstream node id */ };
  output: O;
}
```
Renderer-side composition is compile-time checked against each brick's declared
I/O; the orchestrator validates again at materialize time (runtime guard).

## Visualization (A, objective 1)

- Profiler gains a Graph panel: live node graph, per-node badges (util%, rate,
  maxInterval, drops — reusing the SATURATED flag), per-edge stats (fps, MB/s,
  consumer count). Layout stable across 1 Hz updates; nodes appear/disappear
  with runtime composition (multi-fovea churn must look sane).
- **External lib GRANTED** (user). A picks; requirements: renders offline/local
  (no CDN at runtime), dark-theme, handles ~10-50 nodes, incremental updates
  without full re-layout. Candidates: cytoscape.js (+dagre layout), vis-network,
  or elkjs/d3 + custom SVG. npm install grant LOGGED in split-of-work.
- Stage 1 renders the CURRENT fixed topology (derived from pipes + probes +
  static wiring knowledge); rebased onto the real `graphTopology()` when C's
  model lands — A designs the panel against the contract C publishes early.

## Staging

1. **C sketch**: id scheme + StreamType/NodeSpec harness + topology snapshot
   contract (publish the shape EARLY for A) + composition protocol (window-
   scoped compose/decompose, runtime add/remove, ownership/teardown via the
   existing scope machinery + gates).
2. **B sketch**: native gaps — the fovea crop brick (crop+resize from camera/
   undistort stream → dynamic pipe, C-20 semantics); nodes for tracker/detector
   outputs (meter + typed output stream even if transport stays generator);
   anything the topology snapshot needs natively.
3. **A build**: graph panel with the lib against C's contract (mock first).
4. Ports: multi-fovea onto dynamic fovea nodes (the flagship); other apps
   migrate composition renderer-side incrementally.

## Relation to the application audit (objective 3, parallel)

Fresh auditors fix CURRENT app logic (docs/applications/). Lanes are disjoint:
auditors touch app vision math/UI handlers; real-2 touches plumbing/protocol/
profiler. Composition-migration of audited apps happens AFTER both land.
